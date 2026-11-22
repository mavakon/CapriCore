// SPDX-License-Identifier: GPL-3.0-only
// Window geometry for placing Capri's avatar on another application's window,
// the macOS counterpart of DesktopActions.cs AvatarWindow and the follower in
// desktop-teleport.cs. Only bounds, owner and identity are read: never window
// contents, and nothing here focuses, moves or sends input to an application.
import AppKit
import CoreGraphics
import Foundation

private let minimumWidth: CGFloat = 160
private let minimumHeight: CGFloat = 100

private struct PlacedWindow {
  let id: CGWindowID
  let pid: pid_t
  let layer: Int
  let bounds: CGRect
  let alpha: Double
  let owner: String
  let name: String
  let onScreen: Bool
}

private func placedWindow(_ entry: [String: Any]) -> PlacedWindow? {
  guard let id = (entry[kCGWindowNumber as String] as? NSNumber)?.uint32Value,
    let pid = (entry[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value,
    let boundsValue = entry[kCGWindowBounds as String] as? NSDictionary,
    let bounds = CGRect(dictionaryRepresentation: boundsValue as CFDictionary)
  else { return nil }
  return PlacedWindow(
    id: id, pid: pid, layer: (entry[kCGWindowLayer as String] as? NSNumber)?.intValue ?? 0,
    bounds: bounds, alpha: (entry[kCGWindowAlpha as String] as? NSNumber)?.doubleValue ?? 1,
    owner: entry[kCGWindowOwnerName as String] as? String ?? "",
    // Other applications' titles are visible only with Screen Recording.
    name: entry[kCGWindowName as String] as? String ?? "",
    onScreen: (entry[kCGWindowIsOnscreen as String] as? NSNumber)?.boolValue ?? false)
}

private func placedWindow(_ id: CGWindowID) -> PlacedWindow? {
  guard let list = CGWindowListCopyWindowInfo([.optionIncludingWindow], id) as? [[String: Any]],
    let entry = list.first, let window = placedWindow(entry), window.id == id
  else { return nil }
  return window
}

/// A full-screen window has its own Space, where Capri's avatar is not shown.
private func fullScreen(_ bounds: CGRect) -> Bool {
  displays().contains { $0.bounds.integral == bounds.integral }
}

private func geometry(_ bounds: CGRect) -> (x: Int, y: Int, width: Int, height: Int) {
  let rect = bounds.integral
  return (Int(rect.minX), Int(rect.minY), Int(rect.width), Int(rect.height))
}

/// The visible application window nearest a drop point, named by title, or the
/// exact window of a perch, with the identity the follower verifies later.
func avatarWindow(_ q: JSON) throws -> JSON {
  let title = text(q, "title")
  let requested = text(q, "windowId")
  let expectedProcess = text(q, "processId")
  let expectedStart = text(q, "startedAtTicks")
  let allowed = text(q, "allowedWindowId")
  guard title.utf16.count <= 160, requested.count <= 24, expectedProcess.count <= 12,
    expectedStart.count <= 24, allowed.isEmpty || matches(allowed, "^[1-9][0-9]{0,19}$"),
    requested.isEmpty || matches(requested, "^[1-9][0-9]{0,19}$")
  else { throw HelperError("Invalid window selector.") }
  let near = q["nearRadius"] != nil
  var nearX = 0
  var nearY = 0
  var radius = 0
  if near {
    guard let x = Int(text(q, "nearX")), let y = Int(text(q, "nearY")),
      let r = Int(text(q, "nearRadius")), abs(x) <= 100_000, abs(y) <= 100_000, r >= 1, r <= 400
    else { throw HelperError("Invalid window dock point.") }
    (nearX, nearY, radius) = (x, y, r)
  }
  let ignored = pid_t(text(q, "ignoreProcessId")) ?? 0
  let frontmost = NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0
  let entries: [[String: Any]]
  if let id = CGWindowID(requested) {
    entries = CGWindowListCopyWindowInfo([.optionIncludingWindow], id) as? [[String: Any]] ?? []
  } else {
    entries =
      CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID)
      as? [[String: Any]] ?? []
  }
  var best = Int.max
  var first: JSON?
  var active: JSON?
  var started: [pid_t: String] = [:]
  for entry in entries {
    guard let window = placedWindow(entry), window.onScreen, window.layer == 0, window.alpha > 0,
      window.pid > 0, !systemWindowOwners.contains(window.owner),
      window.pid != ignored || String(window.id) == allowed,
      window.bounds.width >= minimumWidth, window.bounds.height >= minimumHeight,
      !fullScreen(window.bounds)
    else { continue }
    if !requested.isEmpty && String(window.id) != requested { continue }
    let (x, y, width, height) = geometry(window.bounds)
    var distance = Int.max
    if near {
      let insetX = width / 25
      let insetY = height / 25
      if nearX >= x + insetX && nearX <= x + width - insetX {
        distance = min(abs(nearY - y), abs(nearY - (y + height)))
      }
      if nearY >= y + insetY && nearY <= y + height - insetY {
        distance = min(distance, min(abs(nearX - x), abs(nearX - (x + width))))
      }
      if distance > radius || distance >= best { continue }
    }
    if !title.isEmpty && window.name.range(of: title, options: .caseInsensitive) == nil
      && window.owner.range(of: title, options: .caseInsensitive) == nil
    {
      continue
    }
    if started[window.pid] == nil { started[window.pid] = processStartTicks(window.pid) ?? "" }
    guard let ticks = started[window.pid], !ticks.isEmpty else { continue }
    if (!expectedProcess.isEmpty && String(window.pid) != expectedProcess)
      || (!expectedStart.isEmpty && ticks != expectedStart)
    {
      continue
    }
    let result: JSON = [
      "ok": true, "windowId": String(window.id), "processId": String(window.pid),
      "startedAtTicks": ticks, "x": x, "y": y, "width": width, "height": height,
    ]
    if near {
      best = distance
      first = result
      if distance == 0 { break }
      continue
    }
    if first == nil { first = result }
    // Windows are listed front to back; the frontmost application's first window wins.
    if window.pid == frontmost || !requested.isEmpty {
      active = result
      break
    }
  }
  return active ?? first ?? ["ok": true, "windowId": NSNull()]
}

// MARK: - Following a perch and watching the overlay's mouse release

/// `window-follow`: the protocol of desktop-teleport.cs --watch on stdio.
/// In:  `follow <id> <window> <pid> <ticks>` (id 0 stops) and `<overlay window> <id>`
///      (release watch; `0 0` stops).
/// Out: `ready`, `anchor <id> visible <x> <y> <w> <h>` or `anchor <id> hidden|closed`,
///      and `release <id> <x> <y>` when a press that began on the overlay ends.
private final class Follower {
  var anchorId = 0
  var anchorWindow: CGWindowID = 0
  var anchorProcess: pid_t = 0
  var anchorStart = ""
  var lastAnchor = ""
  var identityCheckedAt = 0.0
  var releaseWindow: CGWindowID = 0
  var releaseId = 0
  var buttonDown = false
  var trackRelease = false
  var timer: Timer?

  func send(_ line: String) { Output.raw(Data((line + "\n").utf8)) }

  func follow(_ id: Int, _ window: CGWindowID, _ pid: pid_t, _ ticks: String) {
    anchorId = 0
    lastAnchor = ""
    guard id > 0 else { return schedule() }
    guard window > 0, pid > 0, !ticks.isEmpty, let info = placedWindow(window), info.pid == pid,
      processStartTicks(pid) == ticks
    else {
      send("anchor \(id) closed")
      return schedule()
    }
    (anchorId, anchorWindow, anchorProcess, anchorStart) = (id, window, pid, ticks)
    identityCheckedAt = nowMs()
    poll()
    schedule()
  }

  func watchRelease(_ window: CGWindowID, _ id: Int) {
    (releaseWindow, releaseId) = (window, id)
    trackRelease = false
    buttonDown = CGEventSource.buttonState(.combinedSessionState, button: .left)
    schedule()
  }

  private func end(_ state: String) {
    let id = anchorId
    anchorId = 0
    lastAnchor = ""
    if id != 0 { send("anchor \(id) \(state)") }
  }

  private func pollAnchor() {
    guard anchorId != 0 else { return }
    guard let info = placedWindow(anchorWindow), info.pid == anchorProcess else {
      return end("closed")
    }
    // The start-time check catches a reused process ID; once a second is enough.
    if nowMs() - identityCheckedAt > 1000 {
      identityCheckedAt = nowMs()
      if processStartTicks(anchorProcess) != anchorStart { return end("closed") }
    }
    // Minimized, hidden, on another Space or full screen: the perch ends.
    guard info.onScreen, info.alpha > 0, !fullScreen(info.bounds) else { return end("hidden") }
    let (x, y, width, height) = geometry(info.bounds)
    guard width > 0, height > 0 else { return }
    let state = "visible \(x) \(y) \(width) \(height)"
    if state == lastAnchor { return }
    lastAnchor = state
    send("anchor \(anchorId) \(state)")
  }

  private func pollRelease() {
    guard releaseId != 0 else { return }
    let down = CGEventSource.buttonState(.combinedSessionState, button: .left)
    defer { buttonDown = down }
    guard down != buttonDown else { return }
    let point = CGEvent(source: nil)?.location ?? .zero
    if down {
      // Only a press that starts on the overlay is reported, as on Windows.
      trackRelease = placedWindow(releaseWindow)?.bounds.contains(point) == true
    } else if trackRelease {
      trackRelease = false
      send("release \(releaseId) \(Int(point.x.rounded(.down))) \(Int(point.y.rounded(.down)))")
    }
  }

  func poll() {
    pollAnchor()
    pollRelease()
  }

  /// 60 Hz only while something is followed; nothing runs otherwise.
  func schedule() {
    let needed = anchorId != 0 || releaseId != 0
    if needed && timer == nil {
      let next = Timer(timeInterval: 1.0 / 60, repeats: true) { [weak self] _ in self?.poll() }
      RunLoop.main.add(next, forMode: .common)
      timer = next
    } else if !needed {
      timer?.invalidate()
      timer = nil
    }
  }

  func command(_ line: String) {
    let parts = line.split(separator: " ", omittingEmptySubsequences: false).map(String.init)
    if parts.count == 5, parts[0] == "follow", let id = Int(parts[1]), id >= 0,
      let window = CGWindowID(parts[2]), let pid = pid_t(parts[3]),
      matches(parts[4], "^[0-9]{1,20}$")
    {
      follow(id, window, pid, parts[4])
    } else if parts.count == 2, let window = CGWindowID(parts[0]), let id = Int(parts[1]), id >= 0 {
      watchRelease(id == 0 ? 0 : window, id == 0 ? 0 : id)
    }
  }
}

func runWindowFollow() -> Int32 {
  let follower = Follower()
  follower.send("ready")
  // The owner ends the follower by closing stdin (or exiting).
  Thread.detachNewThread {
    while let line = readLine(strippingNewline: true) {
      if line.utf8.count > 128 { continue }
      DispatchQueue.main.async { follower.command(line) }
    }
    exit(0)
  }
  RunLoop.main.run()
  return 0
}
