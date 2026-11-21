// SPDX-License-Identifier: GPL-3.0-only
// Full-computer observation and input for the owner-started computer-control
// session. Same request and response shapes as the Windows DesktopActions
// helper. Every input re-verifies the observed foreground window, process
// identity and the live control under the pointer immediately before it is sent.
import AppKit
import ApplicationServices

struct Target {
  let pid: pid_t
  let app: AXUIElement
  let window: AXUIElement
  let windowNumber: CGWindowID
}

private var allowedProcesses: [pid_t: Bool] = [:]

/// Any process except this helper and Capri itself (by PID and by executable).
func computerProcessAllowed(_ pid: pid_t, ignored: pid_t = 0) -> Bool {
  if pid <= 0 || pid == ignored || pid == getpid() { return false }
  if let known = allowedProcesses[pid] { return known }
  let allowed = processPath(pid).map { !isCapriExecutable($0) } ?? false
  allowedProcesses[pid] = allowed
  return allowed
}

private let systemWindowOwners: Set<String> = [
  "Dock", "Window Server", "WindowManager", "Control Center", "SystemUIServer",
  "Notification Center", "Spotlight", "loginwindow", "screencaptureui",
]

private func liveWindowNumber(_ pid: pid_t, _ window: AXUIElement) -> CGWindowID? {
  AX.windowNumber(window) ?? matchWindowNumber(pid, window)
}

/// Raises another application's window through Accessibility and LaunchServices.
private func focusApplication(_ pid: pid_t, window number: CGWindowID) -> Bool {
  let app = AX.application(pid)
  let windows = AX.elements(AX.copy(app, kAXWindowsAttribute))
  let window = windows.first(where: { liveWindowNumber(pid, $0) == number })
  AX.set(app, kAXFrontmostAttribute, kCFBooleanTrue)
  if let window {
    AX.set(window, kAXMainAttribute, kCFBooleanTrue)
    AXUIElementPerformAction(window, kAXRaiseAction as CFString)
  }
  _ = NSRunningApplication(processIdentifier: pid)?.activate(options: [])
  let started = nowMs()
  repeat {
    if let front = AX.focusedApplication(), front.pid == pid,
      let focused = AX.focusedWindow(front.element), liveWindowNumber(pid, focused) == number
    {
      return true
    }
    sleepMs(25)
  } while nowMs() - started < 800
  return false
}

/// The window computer control observes: the foreground one, or when Capri is
/// in front, the frontmost normal window of another application.
func observationTarget(_ q: JSON) throws -> Target {
  try AX.requireTrusted()
  let ignored = pid_t(text(q, "ignoreProcessId")) ?? 0
  guard let front = AX.focusedApplication() else {
    throw HelperError("No foreground window is available.")
  }
  if computerProcessAllowed(front.pid, ignored: ignored) {
    guard let window = AX.focusedWindow(front.element),
      let number = liveWindowNumber(front.pid, window)
    else {
      throw HelperError.before(
        "COMPUTER_APPLICATION_UNAVAILABLE",
        "The application in front has no open window. Open one, then try again. No input was sent."
      )
    }
    return Target(pid: front.pid, app: front.element, window: window, windowNumber: number)
  }
  for info in windowList()
  where info.layer == 0 && info.alpha > 0 && info.bounds.width >= 2 && info.bounds.height >= 2
    && !systemWindowOwners.contains(info.ownerName)
    && computerProcessAllowed(info.pid, ignored: ignored)
  {
    guard focusApplication(info.pid, window: info.id) else {
      throw HelperError.before(
        "COMPUTER_FOREGROUND_CHANGED",
        "The application behind Capri could not take focus. Select it and try again. No input was sent."
      )
    }
    let app = AX.application(info.pid)
    guard let window = AX.focusedWindow(app) else { break }
    return Target(pid: info.pid, app: app, window: window, windowNumber: info.id)
  }
  throw HelperError.before(
    "COMPUTER_APPLICATION_UNAVAILABLE",
    "Open the application you want Capri to control. No input was sent.")
}

/// The observed window must still be in front, in the same process instance.
@discardableResult
func inputTarget(_ q: JSON, beforeInput: Bool = false) throws -> Target {
  guard let expected = UInt32(text(q, "windowId")), expected != 0 else {
    throw HelperError("Observe the intended foreground window first.")
  }
  if text(q, "surface") == "taskbar" {
    throw HelperError.before(
      "COMPUTER_OBSERVATION_CHANGED", "macOS has no taskbar target. Observe again. No input was sent.")
  }
  try AX.requireTrusted()
  let changed = "The foreground window changed. Observe it again before input."
  guard let front = AX.focusedApplication(), let window = AX.focusedWindow(front.element),
    let number = liveWindowNumber(front.pid, window), number == expected
  else {
    if beforeInput { throw HelperError.before("COMPUTER_FOREGROUND_CHANGED", changed) }
    throw HelperError(changed)
  }
  if text(q, "processId") != String(front.pid) { throw HelperError("The target process changed.") }
  if !computerProcessAllowed(front.pid) {
    throw HelperError.before(
      "COMPUTER_APPLICATION_UNAVAILABLE",
      "The target application identity could not be verified for input. Select another application and observe it again. No input was sent."
    )
  }
  if processStartTicks(front.pid) != text(q, "startedAtTicks") {
    throw HelperError("The target process restarted.")
  }
  return Target(pid: front.pid, app: front.element, window: window, windowNumber: number)
}

// MARK: - Observation

private func observe(_ q: JSON) throws -> JSON {
  let target = try observationTarget(q)
  let windowAttributes = AX.fetch(
    target.window,
    [
      kAXPositionAttribute, kAXSizeAttribute, kAXTitleAttribute, kAXSubroleAttribute, "AXModal",
      "AXFullScreen", kAXChildrenAttribute,
    ])
  guard let frame = AX.frame(windowAttributes), frame.width > 0, frame.height > 0 else {
    throw HelperError("Window geometry is unavailable.")
  }
  guard let started = processStartTicks(target.pid), let executable = processPath(target.pid)
  else { throw HelperError("The foreground application identity could not be verified.") }
  let browser = isBrowser(target.pid)
  let pointer = Injector.location()
  let focused = AX.focusedElement(target.app)
  var controls: [JSON] = []
  observedNodes(app: target.app, window: target.window) { node in
    if controls.count >= 200 { return false }
    guard let box = node.frame, box.width > 0, box.height > 0, node.enabled, !node.secure,
      box.intersects(frame) || node.path.hasPrefix("m")
    else { return true }
    var editable = node.editable
    var address =
      (node.type == "ControlType.Edit" || node.type == "ControlType.ComboBox")
      && browserAddressField(node, browser: browser)
    let documentAddress =
      node.type == "ControlType.Document" ? browserDocumentAddress(node, browser: browser) : nil
    let documentLocation = documentAddress != nil
    if documentLocation {
      address = true
      editable = false
    }
    let name = node.name
    if name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !editable && !address {
      return true
    }
    let actionable =
      pointerControlTypes.contains(node.type)
      || (["ControlType.Custom", "ControlType.Group", "ControlType.Pane"].contains(node.type)
        && node.hasPress)
    let caption = node.type == "ControlType.Text" ? captionControl(node) : nil
    let captionBounds =
      caption == nil && node.type == "ControlType.Text" ? compactCaptionBounds(node) : nil
    if !editable && !address && !actionable
      && !matches(node.type, "\\.(ComboBox|Slider|Text|Image)$")
    {
      return true
    }
    var value = documentAddress ?? ""
    if !documentLocation && !matches(name, secretLabel, caseInsensitive: true) {
      if editableRoles.contains(node.role), let full = node.stringValue {
        value = clean(full, address ? 2048 : 500)
      } else if node.role == "AXLink", let url = node.url {
        value = clean(url, 500)
      }
    }
    if node.type == "ControlType.Image" && value.isEmpty { value = containingLink(node) }
    let id = node.id(window: target.windowNumber)
    var control: JSON = [
      "id": id, "untrustedName": clean(name, 100), "untrustedValue": value, "type": node.type,
      "automationId": clean(node.identifier, 100), "x": Int(box.minX + box.width / 2),
      "y": Int(box.minY + box.height / 2),
      "imageCandidate": node.type == "ControlType.Image" && box.width >= 96 && box.height >= 80,
      "editable": editable,
      "focused": !documentLocation && focused.map { CFEqual($0, node.element) } == true,
      "browserAddress": address, "browserDocumentAddress": documentLocation,
      "browserSearch": editable && !address && node.inWeb && webSearchField(node),
      "pageContent": node.inWeb, "hovered": box.contains(pointer),
      "selected": node.selected.map { $0 as Any } ?? NSNull(),
    ]
    if actionable { control["clickKind"] = "control" }
    if actionable || editable || caption != nil { control["bounds"] = boundsJSON(box) }
    if node.type == "ControlType.Text" {
      control["clickKind"] = caption != nil ? "caption" : captionBounds == nil ? "text" : "candidate"
      if let caption {
        control["captionControlId"] = caption.id(window: target.windowNumber)
        control["captionControlType"] = caption.type
      }
      if let captionBounds { control["captionBounds"] = boundsJSON(captionBounds) }
    }
    controls.append(control)
    return true
  }
  let subrole = AX.string(windowAttributes[kAXSubroleAttribute]) ?? ""
  let modal =
    AX.boolean(windowAttributes["AXModal"]) == true
    || ["AXDialog", "AXSystemDialog"].contains(subrole)
    || AX.elements(windowAttributes[kAXChildrenAttribute]).contains { AX.role($0) == "AXSheet" }
  let screen = display(for: frame)
  let fullscreen =
    AX.boolean(windowAttributes["AXFullScreen"])
    ?? screen.map {
      abs(frame.minX - $0.bounds.minX) <= 2 && abs(frame.minY - $0.bounds.minY) <= 2
        && abs(frame.maxX - $0.bounds.maxX) <= 2 && abs(frame.maxY - $0.bounds.maxY) <= 2
    } ?? false
  let ordered = controls.enumerated().sorted { left, right in
    let a = observationRank(left.element)
    let b = observationRank(right.element)
    return a != b ? a < b : left.offset < right.offset
  }.map(\.element)
  let selected = observationBudget(ordered)
  let window = rectJSON(frame)
  return [
    "ok": true, "windowId": String(target.windowNumber), "processId": String(target.pid),
    "startedAtTicks": started,
    "untrustedTitle": clean(AX.string(windowAttributes[kAXTitleAttribute]), 180),
    "applicationKind": NSNull(), "discordUserPanel": NSNull(), "discordComposerScan": NSNull(),
    "controlsTruncated": controls.count > selected.count, "executable": executable,
    "resolveExecutable": NSNull(), "modal": modal, "fullscreen": fullscreen,
    "x": window["x"]!, "y": window["y"]!, "width": window["width"]!, "height": window["height"]!,
    "displayBounds": screen.map { rectJSON($0.bounds) as Any } ?? NSNull(),
    "desktopSurfaces": [Any](), "untrustedControls": selected,
  ]
}

private func boundsJSON(_ rect: CGRect) -> JSON {
  ["x": Double(rect.minX), "y": Double(rect.minY), "width": Double(rect.width), "height": Double(rect.height)]
}

private func observationRank(_ control: JSON) -> Double {
  if control["focused"] as? Bool == true { return 0 }
  if control["browserAddress"] as? Bool == true {
    return control["browserDocumentAddress"] as? Bool == true ? 1.5 : 1
  }
  let name = control["untrustedName"] as? String ?? ""
  if matches(name, "^(Images|Картинки|Изображения|Bilder|Imágenes|Imagens)$", caseInsensitive: true)
    || control["imageCandidate"] as? Bool == true
  {
    return 2.5
  }
  return control["clickKind"] as? String == "text" ? 4 : 3
}

private func observationBudget(_ controls: [JSON]) -> [JSON] {
  var result: [JSON] = []
  var size = 0
  for control in controls {
    let length = Output.data(control).count + 1
    if result.count >= 140 || size + length > 50000 { break }
    result.append(control)
    size += length
  }
  return result
}

// MARK: - Pointer verification

/// Capri's own click-through indicator windows, named by the request. Mouse
/// events pass through them, but Accessibility hit-testing can still report them.
private var passThroughWindows = Set<CGWindowID>()

func readPassThroughWindows(_ q: JSON) throws {
  passThroughWindows = []
  guard let list = q["passThroughWindowIds"] else { return }
  guard let ids = list as? [Any], ids.count <= 16 else { throw HelperError("Invalid request.") }
  for raw in ids {
    let text = (raw as? String) ?? (raw as? NSNumber).map { $0.stringValue } ?? ""
    guard let id = UInt32(text), id > 0 else { throw HelperError("Invalid request.") }
    // Only windows that really belong to Capri can be looked through.
    guard let info = windowInfo(id), let path = processPath(info.pid), isCapriExecutable(path)
    else { continue }
    passThroughWindows.insert(id)
  }
}

/// The element under `point`. When the system hit lands on another process and
/// only Capri's click-through indicators lie above the target window there,
/// the target application answers for that point instead.
func hitElement(_ point: CGPoint, _ target: Target) -> AXUIElement? {
  guard let hit = AX.elementAt(point) else { return nil }
  guard !passThroughWindows.isEmpty, AX.pid(hit) != target.pid else { return hit }
  for info in windowList() where info.alpha > 0 && info.bounds.contains(point) {
    if passThroughWindows.contains(info.id) { continue }
    guard info.pid == target.pid else { return hit }
    var element: AXUIElement?
    let status = AXUIElementCopyElementAtPosition(
      target.app, Float(point.x), Float(point.y), &element)
    return status == .success ? element : hit
  }
  return hit
}

/// The pointer at `point` reaches the observed window (or one of its open menus).
func pointerWindowMatches(_ point: CGPoint, _ target: Target) -> Bool {
  guard let hit = hitElement(point, target), AX.pid(hit) == target.pid else { return false }
  if CFEqual(hit, target.window) { return true }
  if let window = AX.element(AX.copy(hit, kAXWindowAttribute)), CFEqual(window, target.window) {
    return true
  }
  var current: AXUIElement? = hit
  for _ in 0..<12 {
    guard let element = current else { break }
    let role = AX.role(element)
    if role == "AXMenu" { return true }
    if role == "AXWindow" { return CFEqual(element, target.window) }
    current = AX.parent(element)
  }
  return false
}

private func hitMatches(_ node: AXNode, _ point: CGPoint, _ target: Target, allowTextContainer: Bool)
  -> Bool
{
  guard let box = node.frame, box.contains(point), let hit = hitElement(point, target) else {
    return false
  }
  if AX.within(hit, node.element, depth: 12) { return true }
  let hitType = controlType(role: AX.role(hit), subrole: AX.string(AX.copy(hit, kAXSubroleAttribute)) ?? "")
  if matches(hitType, "\\.(Button|Hyperlink|ListItem|DataItem)$")
    && AX.within(node.element, hit, depth: 12)
  {
    return true
  }
  if let caption = captionControl(node), AX.within(hit, caption.element, depth: 12) { return true }
  // Some web renderers report an unnamed generic surface for every hit while
  // exposing the caption inside a tight wrapper. Only for an exact owner label.
  guard allowTextContainer, node.type == "ControlType.Text", AX.pid(hit) == AX.pid(node.element),
    ["ControlType.Custom", "ControlType.Group"].contains(hitType),
    (AX.string(AX.copy(hit, kAXTitleAttribute)) ?? "").trimmingCharacters(in: .whitespaces).isEmpty,
    (AX.string(AX.copy(hit, kAXDescriptionAttribute)) ?? "").trimmingCharacters(in: .whitespaces)
      .isEmpty,
    let bounds = compactCaptionBounds(node), let surface = AX.frame(hit), surface.contains(bounds)
  else { return false }
  return true
}

private func pointerTargetMatches(
  _ target: Target, _ node: AXNode?, _ point: CGPoint, allowTextContainer: Bool = false
) -> Bool {
  guard pointerWindowMatches(point, target) else { return false }
  guard let node else { return true }
  let live = AX.fetch(node.element, [kAXEnabledAttribute, kAXRoleAttribute])
  guard AX.string(live[kAXRoleAttribute]) == node.role, AX.boolean(live[kAXEnabledAttribute]) ?? true
  else { return false }
  return hitMatches(node, point, target, allowTextContainer: allowTextContainer)
}

/// Re-reads the live element. Nil once it disappeared, changed or was disabled.
private func pointerTargetIdentity(_ node: AXNode, captionControlId: String, window: CGWindowID)
  -> String?
{
  if !captionControlId.isEmpty {
    guard let control = captionControl(node), control.id(window: window) == captionControlId
    else { return nil }
  }
  let live = AXNode(element: node.element, path: node.path, parent: node.parent)
  guard live.role == node.role, live.enabled, !live.secure else { return nil }
  return live.path + "\u{0}" + live.fingerprint
}

private func findPointerTarget(
  _ target: Target, _ node: AXNode, allowTextContainer: Bool = false
) throws -> CGPoint {
  guard var box = AX.frame(node.element) else {
    throw HelperError.before(
      "COMPUTER_TARGET_STALE", "The observed control disappeared. No click was sent.")
  }
  box = box.intersection(desktopBounds())
  if box.isNull || box.width < 1 || box.height < 1 {
    throw HelperError.before(
      "COMPUTER_TARGET_STALE", "The observed control has no visible geometry. No click was sent.")
  }
  var points = [CGPoint(x: box.minX + box.width / 2, y: box.minY + box.height / 2)]
  for y in [0.5, 0.15, 0.85] {
    for x in [0.5, 0.15, 0.85] {
      points.append(CGPoint(x: box.minX + box.width * x, y: box.minY + box.height * y))
    }
  }
  var seen = Set<String>()
  for candidate in points {
    let point = CGPoint(x: candidate.x.rounded(.down), y: candidate.y.rounded(.down))
    if seen.insert("\(point.x),\(point.y)").inserted,
      pointerTargetMatches(target, node, point, allowTextContainer: allowTextContainer)
    {
      return point
    }
  }
  throw HelperError.before(
    "COMPUTER_TARGET_COVERED", "The observed control has no verified clickable point. No click was sent.")
}

private func cursorMatches(_ point: CGPoint, tolerance: CGFloat = 0) -> Bool {
  let actual = Injector.location()
  return abs(actual.x - point.x) <= tolerance + 0.5 && abs(actual.y - point.y) <= tolerance + 0.5
}

private func cursorHitsTarget(
  _ target: Target, _ node: AXNode?, _ point: CGPoint, allowTextContainer: Bool = false
) -> Bool {
  let tolerance: CGFloat = node == nil ? 0 : 1
  return cursorMatches(point, tolerance: tolerance)
    && pointerTargetMatches(target, node, Injector.location(), allowTextContainer: allowTextContainer)
}

private func verifyVisualPointer(_ q: JSON, _ target: Target, _ point: CGPoint, beforeInput: Bool)
  throws
{
  if let box = q["observedWindowBounds"] as? JSON {
    let live = AX.frame(target.window).map(rectJSON)
    let same =
      live != nil
      && ["x", "y", "width", "height"].allSatisfy { integer(box, $0) == live![$0] as? Int }
    if !same {
      let message =
        "The window moved or resized since the screenshot. Observe it again before using a visual position."
      if beforeInput { throw HelperError.before("COMPUTER_OBSERVATION_CHANGED", message) }
      throw HelperError(message)
    }
  }
  guard bool(q, "visualField") == true else { return }
  guard var hit = hitElement(point, target) else {
    let message = "The control at the visual position changed. Observe again before clicking."
    if beforeInput { throw HelperError.before("COMPUTER_TARGET_STALE", message) }
    throw HelperError(message)
  }
  for _ in 0..<5 {
    let node = AXNode(element: hit, path: "", parent: nil)
    if node.editable && !(node.inToolbar || isBrowser(target.pid) && !isInWeb(hit)) { return }
    if pointerControlTypes.contains(node.type) || node.type == "ControlType.Edit"
      || node.type == "ControlType.ComboBox" || node.secure
    {
      let message =
        "The visual search field points at a different control. Observe again before clicking."
      if beforeInput { throw HelperError.before("COMPUTER_TARGET_NOT_CLICKABLE", message) }
      throw HelperError(message)
    }
    if node.type == "ControlType.Document" || node.type == "ControlType.Window" { break }
    guard let parent = AX.parent(hit) else { break }
    hit = parent
  }
}

private func isInWeb(_ element: AXUIElement) -> Bool {
  var current: AXUIElement? = element
  for _ in 0..<48 {
    guard let node = current else { return false }
    let role = AX.role(node)
    if role == "AXWebArea" { return true }
    if role == "AXWindow" { return false }
    current = AX.parent(node)
  }
  return false
}

private func motionDuration(_ q: JSON, _ fallback: Int) throws -> Double {
  let value = q["durationMs"] == nil ? fallback : (integer(q, "durationMs") ?? -1)
  if value < 0 || value > 2000 { throw HelperError("Pointer motion must be within two seconds.") }
  return Double(value)
}

private func movePointer(
  _ q: JSON, _ injector: Injector, _ target: Target, to point: CGPoint, duration: Double,
  dragging: Bool = false
) throws {
  let start = Injector.location()
  let began = nowMs()
  while true {
    try inputTarget(q, beforeInput: !dragging)
    let t = duration == 0 ? 1 : min(1, (nowMs() - began) / duration)
    let ease = t * t * (3 - 2 * t)
    let next = CGPoint(
      x: (start.x + (point.x - start.x) * ease).rounded(),
      y: (start.y + (point.y - start.y) * ease).rounded())
    if dragging && !pointerWindowMatches(next, target) {
      throw HelperError("Another window covers the drag path. Drag stopped.")
    }
    try injector.move(to: t >= 1 ? point : next, dragging: dragging)
    if t >= 1 { break }
    sleepMs(12)
  }
}

// MARK: - Actions

private func keyList(_ q: JSON) throws -> [CGKeyCode] {
  guard let raw = q["keys"] else { return [] }
  guard let list = raw as? [Any] else { return [] }
  var keys: [CGKeyCode] = []
  for item in list {
    guard let name = item as? String else { throw HelperError("Unsupported keyboard key.") }
    let code = try Keys.code(name)
    if !keys.contains(code) { keys.append(code) }
  }
  if keys.count > 4 { throw HelperError("Use at most four keys in one chord.") }
  return keys
}

private func windowExists(_ q: JSON) throws -> JSON {
  guard let id = UInt32(text(q, "windowId")), id > 0, let pid = pid_t(text(q, "processId")),
    pid > 0, let started = Int64(text(q, "startedAtTicks")), started > 0
  else { throw HelperError("Invalid window identity.") }
  guard let info = windowInfo(id), info.pid == pid else { return ["ok": true, "exists": false] }
  return ["ok": true, "exists": processStartTicks(pid) == String(started)]
}

private func release(_ q: JSON) -> JSON {
  let injector = Injector()
  for key in (try? keyList(q)) ?? [] { try? injector.key(key, down: false) }
  let button = text(q, "button")
  if ["left", "right", "middle"].contains(button) {
    try? injector.button(button, down: false, at: Injector.location())
  }
  return ["ok": true, "released": true]
}

private func keys(_ q: JSON) throws -> JSON {
  let keys = try keyList(q)
  let hold = q["holdMs"] == nil ? 0 : (integer(q, "holdMs") ?? -1)
  if keys.isEmpty || hold < 0 || hold > 2000 { throw HelperError("Invalid key hold.") }
  let target = try inputTarget(q, beforeInput: true)
  let expected = text(q, "focusedControlId")
  if !expected.isEmpty {
    guard let focus = AX.focusedElement(target.app),
      let node = findNode(expected, app: target.app, window: target.window, windowNumber: target.windowNumber),
      CFEqual(focus, node.element)
    else {
      throw HelperError.before(
        "COMPUTER_FOREGROUND_CHANGED", "Keyboard focus changed since observation. No keys were sent.")
    }
  }
  if q["expectedValueSha256"] != nil || q["expectedDiscordPaneId"] != nil {
    throw HelperError.before(
      "COMPUTER_OBSERVATION_CHANGED", "Observe the message composer again before submitting it.")
  }
  let injector = Injector()
  var pressed: [CGKeyCode] = []
  defer { for key in pressed.reversed() { try? injector.key(key, down: false) } }
  for key in keys {
    do { try inputTarget(q, beforeInput: pressed.isEmpty) } catch let error as HelperError {
      if pressed.isEmpty {
        throw HelperError.before(
          "COMPUTER_FOREGROUND_CHANGED", "The foreground window changed. No keys were sent.")
      }
      throw HelperError("The foreground window changed during input.", code: error.code)
    }
    try injector.key(key, down: true)
    pressed.append(key)
  }
  let began = nowMs()
  while nowMs() - began < Double(hold) {
    do { try inputTarget(q) } catch { throw HelperError("The foreground window changed during input.") }
    sleepMs(15)
  }
  return ["ok": true, "confirmation": "Pressed the requested keys."]
}

private func scroll(_ q: JSON) throws -> JSON {
  guard let amount = integer(q, "amount"), amount != 0, abs(amount) <= 10 else {
    throw HelperError("Use one to ten scroll steps.")
  }
  try inputTarget(q, beforeInput: true)
  try Injector().scroll(amount)
  return ["ok": true, "confirmation": "Scrolled the foreground window."]
}

private func resolvePoint(
  _ q: JSON, _ target: Target, id key: String, x xKey: String, y yKey: String
) throws -> CGPoint {
  guard let x = integer(q, xKey), let y = integer(q, yKey) else {
    throw HelperError("Invalid drag position.")
  }
  var point = CGPoint(x: x, y: y)
  let id = text(q, key)
  if !id.isEmpty {
    guard
      let node = findNode(
        id, app: target.app, window: target.window, windowNumber: target.windowNumber, near: point),
      node.enabled, let box = AX.frame(node.element), box.width > 0, box.height > 0
    else { throw HelperError("The drag target is no longer visible.") }
    point = CGPoint(x: Int(box.minX + box.width / 2), y: Int(box.minY + box.height / 2))
  }
  if !pointerWindowMatches(point, target) {
    throw HelperError("Another window covers the drag target.")
  }
  return point
}

private func drag(_ q: JSON) throws -> JSON {
  if !text(q, "surface").isEmpty {
    throw HelperError("Drag is limited to the observed application.")
  }
  var modifiers: [CGKeyCode] = []
  if let list = q["modifiers"] as? [Any] {
    for item in list {
      guard let name = item as? String, ["CTRL", "SHIFT", "ALT"].contains(name) else {
        throw HelperError("Invalid drag modifier.")
      }
      let code = try Keys.code(name)
      if modifiers.contains(code) { throw HelperError("Duplicate drag modifier.") }
      modifiers.append(code)
    }
  }
  let target = try inputTarget(q, beforeInput: true)
  let from = try resolvePoint(q, target, id: "controlId", x: "x", y: "y")
  let to = try resolvePoint(q, target, id: "toControlId", x: "toX", y: "toY")
  var trajectory: [CGPoint] = []
  if let path = q["trajectory"] as? [Any] {
    guard let bounds = AX.frame(target.window) else {
      throw HelperError("Drag geometry unavailable.")
    }
    for entry in path {
      guard let point = entry as? JSON, let x = number(point, "x"), let y = number(point, "y"),
        trajectory.count < 24, x >= 0, x < 1, y >= 0, y < 1
      else { throw HelperError("Invalid drag path.") }
      let next = CGPoint(
        x: (bounds.minX + x * bounds.width).rounded(.down),
        y: (bounds.minY + y * bounds.height).rounded(.down))
      if !pointerWindowMatches(next, target) {
        throw HelperError("Another window covers the recorded drag path.")
      }
      trajectory.append(next)
    }
  }
  trajectory.append(to)
  if userInputBusy() { throw HelperError("Release mouse and modifier keys before dragging.") }
  let approach = try motionDuration(q, 350)
  let travel = try motionDuration(q, 500)
  let injector = Injector()
  try movePointer(q, injector, target, to: from, duration: approach)
  try inputTarget(q)
  var pressedModifiers: [CGKeyCode] = []
  var buttonDown = false
  defer {
    if buttonDown { try? injector.button("left", down: false, at: Injector.location()) }
    for key in pressedModifiers.reversed() { try? injector.key(key, down: false) }
  }
  for key in modifiers {
    try injector.key(key, down: true)
    pressedModifiers.append(key)
  }
  try injector.button("left", down: true, at: from)
  buttonDown = true
  sleepMs(80)
  let segment = max(20, max(200, travel) / Double(trajectory.count))
  for point in trajectory {
    try movePointer(q, injector, target, to: point, duration: segment, dragging: true)
  }
  sleepMs(80)
  try injector.button("left", down: false, at: Injector.location())
  buttonDown = false
  return ["ok": true, "confirmation": "Dragged between the observed targets. Verify the result."]
}

private func pointer(_ q: JSON, click: Bool) throws -> JSON {
  guard let x = integer(q, "x"), let y = integer(q, "y") else {
    throw HelperError("Pointer coordinates are outside the desktop.")
  }
  var point = CGPoint(x: x, y: y)
  let desktop = desktopBounds()
  let controlId = text(q, "controlId")
  let captionControlId = text(q, "captionControlId")
  let exactLabel = text(q, "exactLabel")
  let allowTextContainer =
    click && text(q, "button") == "left" && integer(q, "clickCount") == 1 && !exactLabel.isEmpty
    && exactLabel.utf16.count <= 100
  var target = try inputTarget(q, beforeInput: true)
  var node: AXNode?
  var identity: String?
  if !controlId.isEmpty {
    node = findNode(
      controlId, app: target.app, window: target.window, windowNumber: target.windowNumber,
      near: point)
    guard let found = node else {
      throw HelperError.before(
        "COMPUTER_TARGET_STALE", "The observed control disappeared. No click was sent.")
    }
    if allowTextContainer
      && found.name.trimmingCharacters(in: .whitespacesAndNewlines).caseInsensitiveCompare(exactLabel)
        != .orderedSame
    {
      throw HelperError.before(
        "COMPUTER_TARGET_STALE", "The exact control label changed. No click was sent.")
    }
    identity = pointerTargetIdentity(found, captionControlId: captionControlId, window: target.windowNumber)
    if identity == nil {
      throw HelperError.before(
        "COMPUTER_TARGET_STALE", "The observed control is no longer available. No click was sent.")
    }
    point = try findPointerTarget(target, found, allowTextContainer: allowTextContainer)
  }
  if desktop.isNull || !desktop.contains(point) {
    throw HelperError("Pointer coordinates are outside the desktop.")
  }
  target = try inputTarget(q, beforeInput: true)
  if !pointerWindowMatches(point, target) {
    throw HelperError.before(
      "COMPUTER_TARGET_COVERED", "Another window covers the pointer target. No click was sent.")
  }
  if node == nil { try verifyVisualPointer(q, target, point, beforeInput: true) }
  let injector = Injector()
  let motion = try motionDuration(q, 220)
  try movePointer(q, injector, target, to: point, duration: motion)
  if click {
    let button = text(q, "button")
    guard ["left", "right", "middle"].contains(button) else {
      throw HelperError("Invalid pointer button.")
    }
    let count = q["clickCount"] == nil ? 1 : (integer(q, "clickCount") ?? 0)
    if count < 1 || count > 2 { throw HelperError("Invalid click count.") }
    // Hover can change layout. Re-read the same live control once before any button goes down.
    sleepMs(16)
    target = try inputTarget(q, beforeInput: true)
    if !cursorMatches(point, tolerance: node == nil ? 0 : 1) {
      throw HelperError.before(
        "COMPUTER_INPUT_BUSY", "The pointer moved before the click. No click was sent.")
    }
    if let found = node {
      if pointerTargetIdentity(found, captionControlId: captionControlId, window: target.windowNumber)
        != identity
      {
        throw HelperError.before(
          "COMPUTER_TARGET_STALE", "The observed control changed before the click. No click was sent.")
      }
      if !pointerTargetMatches(target, found, point, allowTextContainer: allowTextContainer) {
        point = try findPointerTarget(target, found, allowTextContainer: allowTextContainer)
        try movePointer(q, injector, target, to: point, duration: min(120, motion))
        sleepMs(16)
      }
    }
    for index in 0..<count {
      if index > 0 { sleepMs(min(60, max(1, doubleClickIntervalMs() / 3))) }
      let changed =
        node != nil
        && pointerTargetIdentity(node!, captionControlId: captionControlId, window: target.windowNumber)
          != identity
      if index == 0 && changed {
        throw HelperError.before(
          "COMPUTER_TARGET_STALE", "The observed control changed before the click. No click was sent.")
      }
      target = try inputTarget(q, beforeInput: index == 0)
      if changed || !cursorHitsTarget(target, node, point, allowTextContainer: allowTextContainer) {
        if index > 0 {
          throw HelperError(
            "The second click was skipped because the pointer target changed after the first click.")
        }
        throw HelperError.before(
          "COMPUTER_TARGET_COVERED",
          "The pointer target could not be verified immediately before the click. No click was sent.")
      }
      if node == nil { try verifyVisualPointer(q, target, point, beforeInput: index == 0) }
      let at = Injector.location()
      defer { try? injector.button(button, down: false, at: at, clickState: Int64(index + 1)) }
      try injector.button(button, down: true, at: at, clickState: Int64(index + 1))
    }
  }
  return [
    "ok": true,
    "confirmation": click ? "Clicked the requested position." : "Moved the pointer.",
  ]
}

// MARK: - Text entry

private func fieldHasFocus(_ target: Target, _ field: AXUIElement) -> Bool {
  guard let focused = AX.focusedElement(target.app) else { return false }
  return AX.within(focused, field, depth: 12)
}

private func normalized(_ value: String) -> String {
  value.replacingOccurrences(of: "\r\n", with: "\n")
}

private func verifyObservedDraft(_ q: JSON, _ field: AXNode) throws {
  guard q["expectedValueSha256"] != nil || q["expectedDiscordPaneId"] != nil else { return }
  let expected = text(q, "expectedValueSha256")
  guard q["expectedDiscordPaneId"] == nil, matches(expected, "^[a-f0-9]{64}$"),
    let value = AX.string(AX.copy(field.element, kAXValueAttribute)), value.utf16.count <= 8000,
    sha256Hex(value) == expected
  else {
    throw HelperError.before(
      "COMPUTER_OBSERVATION_CHANGED", "The message draft changed. It was not overwritten or submitted.")
  }
}

private func typeText(_ q: JSON) throws -> JSON {
  let text = Capri.text(q, "text")
  if text.isEmpty || text.utf16.count > 4000 { throw HelperError("Invalid input text.") }
  let append = Capri.text(q, "mode") == "append"
  var target = try inputTarget(q, beforeInput: true)
  guard
    let node = findNode(
      Capri.text(q, "controlId"), app: target.app, window: target.window,
      windowNumber: target.windowNumber),
    node.editable, let frame = node.frame, frame.intersects(AX.frame(target.window) ?? .null)
  else {
    throw HelperError.before(
      "COMPUTER_FIELD_STALE", "That editable target is no longer available. No text was sent.")
  }
  let current = node.stringValue ?? ""
  let next = append ? current + text : text
  if next.utf16.count > 8000 { throw HelperError("The resulting text is too long.") }
  try verifyObservedDraft(q, node)
  if userInputBusy() {
    throw HelperError.before(
      "COMPUTER_INPUT_BUSY", "Release mouse and modifier keys before text entry. No text was sent.")
  }
  let injector = Injector()
  let browser = isBrowser(target.pid)
  let address = browserAddressField(node, browser: browser)
  var field = node
  if address {
    // Focus the observed address field with the browser's own shortcut rather
    // than clicking toolbar coordinates that may animate.
    try inputTarget(q)
    do {
      defer { try? injector.key(Keys.command, down: false) }
      try injector.key(Keys.command, down: true)
      try injector.key(Keys.letterL, down: true)
      try injector.key(Keys.letterL, down: false)
    }
    let began = nowMs()
    var focused: AXNode?
    repeat {
      try inputTarget(q)
      if let element = AX.focusedElement(target.app) {
        let candidate = AXNode(element: element, path: "", parent: nil)
        if candidate.editable && !isInWeb(element) { focused = candidate }
      }
      if focused != nil { break }
      sleepMs(40)
    } while nowMs() - began < 600
    guard let focusedField = focused else {
      throw HelperError.before(
        "COMPUTER_FIELD_FOCUS_CHANGED",
        "The observed browser address field could not be focused. No text was sent.")
    }
    field = focusedField
  } else if !fieldHasFocus(target, node.element) {
    guard let identity = pointerTargetIdentity(node, captionControlId: "", window: target.windowNumber)
    else {
      throw HelperError.before(
        "COMPUTER_FIELD_STALE", "The text field is no longer available. No text was sent.")
    }
    var point = try findPointerTarget(target, node)
    let motion = try motionDuration(q, 220)
    for attempt in 0..<2 {
      try movePointer(q, injector, target, to: point, duration: attempt == 0 ? motion : min(120, motion))
      sleepMs(16)
      target = try inputTarget(q, beforeInput: true)
      if !cursorMatches(point, tolerance: 1) {
        throw HelperError.before(
          "COMPUTER_INPUT_BUSY", "The pointer moved before the field could be focused. No text was sent.")
      }
      if pointerTargetIdentity(node, captionControlId: "", window: target.windowNumber) != identity {
        throw HelperError.before(
          "COMPUTER_FIELD_STALE", "The text field changed while aiming. No text was sent.")
      }
      if pointerTargetMatches(target, node, point) { break }
      if attempt == 1 {
        throw HelperError.before(
          "COMPUTER_TARGET_COVERED", "The text field moved or became covered. No text was sent.")
      }
      point = try findPointerTarget(target, node)
    }
    try verifyObservedDraft(q, node)
    target = try inputTarget(q, beforeInput: true)
    if !cursorHitsTarget(target, node, point) {
      throw HelperError.before(
        "COMPUTER_FIELD_FOCUS_CHANGED", "The text field changed before clicking. No text was sent.")
    }
    do {
      defer { try? injector.button("left", down: false, at: point) }
      try injector.button("left", down: true, at: point)
    }
    let began = nowMs()
    repeat {
      try inputTarget(q, beforeInput: true)
      if fieldHasFocus(target, node.element) { break }
      sleepMs(25)
    } while nowMs() - began < 400
    if !fieldHasFocus(target, node.element) {
      // Some views take focus only through Accessibility after the click.
      AX.set(node.element, kAXFocusedAttribute, kCFBooleanTrue)
      sleepMs(60)
      if !fieldHasFocus(target, node.element) {
        throw HelperError.before(
          "COMPUTER_FIELD_FOCUS_CHANGED",
          "The click did not focus the intended field. Observe it again; no text was sent.")
      }
    }
  }
  // Select what the entry replaces (or place the caret at the end), then send
  // real Unicode key events so web pages see ordinary typing.
  try inputTarget(q)
  try verifyObservedDraft(q, field)
  let existing = AX.string(AX.copy(field.element, kAXValueAttribute)) ?? ""
  var selection = CFRange(location: append ? existing.utf16.count : 0, length: append ? 0 : existing.utf16.count)
  let placed =
    AX.settable(field.element, kAXSelectedTextRangeAttribute)
    && AXValueCreate(.cfRange, &selection).map { AX.set(field.element, kAXSelectedTextRangeAttribute, $0) }
      == true
  if !placed {
    defer { try? injector.key(Keys.command, down: false) }
    try injector.key(Keys.command, down: true)
    let key = append ? Keys.downArrow : Keys.letterA
    try injector.key(key, down: true)
    try injector.key(key, down: false)
  }
  try inputTarget(q)
  if !fieldHasFocus(target, field.element) {
    throw HelperError("Keyboard focus changed during text entry. Check the field before retrying.")
  }
  try verifyObservedDraft(q, field)
  try injector.type(text)
  // Long input can still be queued by the target after the events are posted.
  // Wait for this exact field, never retype it.
  let verification = min(5000, 1200 + Double(text.utf16.count) * 4)
  let began = nowMs()
  let expected = normalized(next)
  while nowMs() - began < verification {
    try inputTarget(q)
    let value = normalized(AX.string(AX.copy(field.element, kAXValueAttribute)) ?? "")
    var completion = false
    if address, value.hasPrefix(expected), value.utf16.count > expected.utf16.count,
      let range = AX.range(AX.copy(field.element, kAXSelectedTextRangeAttribute))
    {
      // Browsers select their inline completion after the typed text.
      completion = range.location == expected.utf16.count
    }
    if value == expected || completion {
      return [
        "ok": true, "typed": true, "submitted": false, "windowId": Capri.text(q, "windowId"),
        "confirmation": "Clicked the field and entered the text without submitting it.",
      ]
    }
    sleepMs(50)
  }
  throw HelperError("Text entry could not be verified. Check the field before retrying.")
}

// MARK: - Escape watcher

/// Reports Escape while Capri's owner process lives. Read-only: it never injects
/// input, and it stops on parent exit, end of input or its lifetime.
private func watchEscape(_ q: JSON) throws {
  guard let parent = integer(q, "parentPid").map({ pid_t($0) }), parent > 0, parent != getpid(),
    let duration = integer(q, "durationMs"), duration >= 1000, duration <= 600_000
  else { throw HelperError("Invalid Escape watcher lifetime.") }
  guard let started = processStartTicks(parent) else {
    throw HelperError("Escape watcher owner exited.")
  }
  // A listen-only event tap sees Escape even when another app has focus. It
  // needs Accessibility (or Input Monitoring); the key-state poll backs it up.
  let mask = CGEventMask(1 << CGEventType.keyDown.rawValue)
  let tap = CGEvent.tapCreate(
    tap: .cgSessionEventTap, place: .tailAppendEventTap, options: .listenOnly,
    eventsOfInterest: mask,
    callback: { _, type, event, _ in
      if type == .keyDown, event.getIntegerValueField(.keyboardEventKeycode) == Int64(Keys.escape) {
        Output.line(["ok": true, "event": "escape"])
        exit(0)
      }
      return Unmanaged.passUnretained(event)
    }, userInfo: nil)
  guard let tap else {
    throw HelperError(
      "macOS did not allow Capri to watch for Escape. Allow it in Privacy & Security → Accessibility.")
  }
  let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
  CFRunLoopAddSource(CFRunLoopGetMain(), source, .commonModes)
  CGEvent.tapEnable(tap: tap, enable: true)
  Output.line(["ok": true, "event": "armed"])
  let began = nowMs()
  let timer = Timer(timeInterval: 0.02, repeats: true) { _ in
    if processStartTicks(parent) != started {
      Output.line(["ok": true, "event": "parent_exit"])
      exit(0)
    }
    if !CGEvent.tapIsEnabled(tap: tap) { CGEvent.tapEnable(tap: tap, enable: true) }
    if CGEventSource.keyState(.hidSystemState, key: Keys.escape) {
      Output.line(["ok": true, "event": "escape"])
      exit(0)
    }
    if nowMs() - began >= Double(duration) {
      Output.line(["ok": true, "event": "expired"])
      exit(0)
    }
  }
  RunLoop.main.add(timer, forMode: .common)
  // The owner closes stdin after the request, so only the parent identity,
  // Escape and the lifetime end the watcher (and the owner can kill it).
  RunLoop.main.run()
}

// MARK: - Entry point

func runDesktopActions() -> Int32 {
  do {
    guard let line = readRequestLine(limit: 16384) else { throw HelperError("Invalid request.") }
    let q = try parseObject(line)
    let action = text(q, "action")
    try readPassThroughWindows(q)
    if action == "computer_watch_escape" {
      try watchEscape(q)
      return 0
    }
    let result: JSON
    switch action {
    case "computer_window_exists": result = try windowExists(q)
    case "computer_state": result = try observe(q)
    case "computer_release": result = release(q)
    case "computer_keys": result = try keys(q)
    case "computer_scroll": result = try scroll(q)
    case "computer_drag": result = try drag(q)
    case "computer_pointer": result = try pointer(q, click: false)
    case "computer_click": result = try pointer(q, click: true)
    case "computer_type": result = try typeText(q)
    case "macos_permissions": result = permissionStatus()
    default:
      throw HelperError(
        "This application action is not available on macOS yet. Open the app yourself, then ask again.",
        code: action.hasPrefix("computer_") ? nil : "MACOS_ACTION_UNAVAILABLE")
    }
    Output.line(result)
    return 0
  } catch {
    Output.line(failure(error))
    return 1
  }
}
