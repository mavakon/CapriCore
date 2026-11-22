// SPDX-License-Identifier: GPL-3.0-only
// Event metadata only, the macOS counterpart of WindowsEvents.cs: which
// application is in front, idle, lock, sleep and logout. Never screenshots,
// window titles, document text or microphone audio. The event vocabulary (and
// the "windows-events" source name the shared JavaScript validates) is unchanged.
import AppKit
import ApplicationServices

private var ignoredProcesses = Set<pid_t>()
private var filterProcess: pid_t = 0
private var lastKey: String?
private var lastFullscreen = false
private var idle = false
private var observedPid: pid_t = 0
private var titleObserver: AXObserver?

private func emit(_ kind: String, _ fields: JSON = [:]) {
  var value: JSON = [
    "schemaVersion": 1, "source": "windows-events", "id": UUID().uuidString.lowercased(),
    "timestamp": Int64(Date().timeIntervalSince1970 * 1000), "confidence": 1, "kind": kind,
  ]
  for (key, field) in fields { value[key] = field }
  Output.line(value)
}

/// The executable name, as Windows reports a process name (without a path).
private func processName(_ pid: pid_t) -> String? {
  guard let path = processPath(pid) else { return nil }
  let name = (path as NSString).lastPathComponent
  let cleaned = String(name.unicodeScalars.filter { $0.value >= 0x20 && $0.value != 0x7F })
  return cleaned.isEmpty ? nil : clean(cleaned, 80)
}

private func observed(_ pid: pid_t) -> Bool {
  !ignoredProcesses.contains(pid) && (filterProcess == 0 || pid == filterProcess)
}

private func browserTabChanged(_ pid: pid_t, _ window: CGWindowID?) {
  guard observed(pid), isBrowser(pid), let window, let name = processName(pid) else { return }
  emit("browser.tab-changed", ["windowId": String(window), "processName": name])
}

private func foreground(refresh: Bool = false) {
  guard let front = foregroundWindowNumber(), observed(front.pid) else { return }
  let key = front.window.map { "w\($0)" } ?? "p\(front.pid)"
  if !refresh && key == lastKey { return }
  var fullscreen = false
  if let window = front.window, let info = windowInfo(window), let screen = display(for: info.bounds) {
    fullscreen =
      info.bounds.minX <= screen.bounds.minX + 2 && info.bounds.minY <= screen.bounds.minY + 2
      && info.bounds.maxX >= screen.bounds.maxX - 2 && info.bounds.maxY >= screen.bounds.maxY - 2
  }
  if key == lastKey && fullscreen == lastFullscreen { return }
  guard let name = processName(front.pid) else { return }
  let switched = key != lastKey
  lastKey = key
  lastFullscreen = fullscreen
  var fields: JSON = ["processName": name, "processId": Int(front.pid), "fullscreen": fullscreen]
  if let window = front.window { fields["windowId"] = String(window) }
  emit("app.foreground", fields)
  if switched { browserTabChanged(front.pid, front.window) }
  watchTitles(front.pid)
}

/// With Accessibility, window switches inside the front app and browser tab
/// changes (a new window title) arrive as notifications. The title is never read.
private func watchTitles(_ pid: pid_t) {
  guard AX.trusted(), pid != observedPid else { return }
  if let observer = titleObserver {
    CFRunLoopRemoveSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(observer), .defaultMode)
    titleObserver = nil
  }
  observedPid = pid
  var created: AXObserver?
  let callback: AXObserverCallback = { _, element, notification, _ in
    let name = notification as String
    if name == kAXFocusedWindowChangedNotification || name == kAXMainWindowChangedNotification {
      foreground(refresh: true)
    } else if name == kAXTitleChangedNotification, AX.role(element) == "AXWindow",
      let pid = AX.pid(element), let front = foregroundWindowNumber(), front.pid == pid,
      let number = AX.windowNumber(element) ?? matchWindowNumber(pid, element),
      number == front.window
    {
      browserTabChanged(pid, number)
    }
  }
  guard AXObserverCreate(pid, callback, &created) == .success, let observer = created else { return }
  let app = AX.application(pid)
  for notification in [
    kAXFocusedWindowChangedNotification, kAXMainWindowChangedNotification,
    kAXTitleChangedNotification,
  ] {
    AXObserverAddNotification(observer, app, notification as CFString, nil)
  }
  CFRunLoopAddSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(observer), .defaultMode)
  titleObserver = observer
}

private func idleSeconds() -> Double {
  guard let any = CGEventType(rawValue: ~0) else { return 0 }
  return CGEventSource.secondsSinceLastEventType(.hidSystemState, eventType: any)
}

func runWindowEvents() -> Int32 {
  guard let line = readRequestLine(limit: 4096), let settings = try? parseObject(line) else {
    return 0
  }
  if settings["filterProcessId"] != nil {
    guard let value = integer(settings, "filterProcessId"), value >= 0 else { return 1 }
    filterProcess = pid_t(value)
  }
  if let ids = settings["ignoredProcessIds"] as? [Any] {
    for id in ids {
      guard let number = id as? NSNumber, !isBoolean(number), number.int32Value > 0 else {
        return 1
      }
      ignoredProcesses.insert(number.int32Value)
    }
  }
  ignoredProcesses.insert(getpid())

  let workspace = NSWorkspace.shared.notificationCenter
  let main = OperationQueue.main
  workspace.addObserver(
    forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: main
  ) { _ in foreground() }
  workspace.addObserver(forName: NSWorkspace.willSleepNotification, object: nil, queue: main) {
    _ in emit("power.suspend")
  }
  workspace.addObserver(forName: NSWorkspace.didWakeNotification, object: nil, queue: main) { _ in
    emit("power.resume")
    lastKey = nil
    foreground()
  }
  workspace.addObserver(forName: NSWorkspace.willPowerOffNotification, object: nil, queue: main) {
    _ in emit("session.ending")
  }
  let distributed = DistributedNotificationCenter.default()
  distributed.addObserver(
    forName: Notification.Name("com.apple.screenIsLocked"), object: nil, queue: main
  ) { _ in emit("session.lock") }
  distributed.addObserver(
    forName: Notification.Name("com.apple.screenIsUnlocked"), object: nil, queue: main
  ) { _ in
    emit("session.unlock")
    lastKey = nil
    foreground()
  }
  let timer = Timer(timeInterval: 1, repeats: true) { _ in
    foreground(refresh: true)
    let now = idleSeconds() >= 300
    if now != idle {
      idle = now
      emit(now ? "user.idle" : "user.return")
    }
  }
  RunLoop.main.add(timer, forMode: .common)
  Output.line([
    "type": "ready", "source": "windows-events", "capturesImages": false, "capturesTitles": false,
  ])
  foreground()
  // The owner ends observation by closing stdin (or exiting).
  Thread.detachNewThread {
    while readLine() != nil {}
    exit(0)
  }
  RunLoop.main.run()
  return 0
}
