// SPDX-License-Identifier: GPL-3.0-only
// Accessibility (AXUIElement) access, window identity and the role vocabulary
// shared with the Windows UI Automation helpers ("ControlType.Button", ...).
import AppKit
import ApplicationServices
import CoreGraphics

@_silgen_name("_AXUIElementGetWindow")
private func axWindowNumber(_ element: AXUIElement, _ identifier: UnsafeMutablePointer<CGWindowID>)
  -> AXError

enum AX {
  static let systemWide = AXUIElementCreateSystemWide()

  static func trusted() -> Bool { AXIsProcessTrusted() }

  static func requireTrusted() throws {
    if !trusted() {
      throw HelperError.before(
        "COMPUTER_ACCESSIBILITY_REQUIRED",
        "macOS has not allowed Capri to control the computer. Turn on Capri (or the app that started it) in System Settings → Privacy & Security → Accessibility, then try again. No input was sent."
      )
    }
  }

  static func copy(_ element: AXUIElement, _ attribute: String) -> CFTypeRef? {
    var value: CFTypeRef?
    return AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success
      ? value : nil
  }

  /// One round trip for many attributes. Missing attributes are left out.
  static func fetch(_ element: AXUIElement, _ attributes: [String]) -> [String: CFTypeRef] {
    var values: CFArray?
    guard
      AXUIElementCopyMultipleAttributeValues(
        element, attributes as CFArray, AXCopyMultipleAttributeOptions(rawValue: 0), &values)
        == .success,
      let array = values as? [AnyObject], array.count == attributes.count
    else { return [:] }
    var result: [String: CFTypeRef] = [:]
    for (index, value) in array.enumerated() {
      if CFGetTypeID(value) == CFNullGetTypeID() { continue }
      if CFGetTypeID(value) == AXValueGetTypeID(), AXValueGetType(value as! AXValue) == .axError {
        continue
      }
      result[attributes[index]] = value
    }
    return result
  }

  static func string(_ value: CFTypeRef?) -> String? {
    guard let value, CFGetTypeID(value) == CFStringGetTypeID() else { return nil }
    return value as? String
  }

  static func boolean(_ value: CFTypeRef?) -> Bool? {
    guard let value else { return nil }
    if CFGetTypeID(value) == CFBooleanGetTypeID() { return CFBooleanGetValue((value as! CFBoolean)) }
    if CFGetTypeID(value) == CFNumberGetTypeID() { return (value as? NSNumber)?.boolValue }
    return nil
  }

  static func element(_ value: CFTypeRef?) -> AXUIElement? {
    guard let value, CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
    return (value as! AXUIElement)
  }

  static func elements(_ value: CFTypeRef?) -> [AXUIElement] {
    guard let value, CFGetTypeID(value) == CFArrayGetTypeID(), let array = value as? [AnyObject]
    else { return [] }
    return array.compactMap { element($0) }
  }

  static func point(_ value: CFTypeRef?) -> CGPoint? {
    guard let value, CFGetTypeID(value) == AXValueGetTypeID() else { return nil }
    let axValue = value as! AXValue
    var point = CGPoint.zero
    return AXValueGetType(axValue) == .cgPoint && AXValueGetValue(axValue, .cgPoint, &point)
      ? point : nil
  }

  static func size(_ value: CFTypeRef?) -> CGSize? {
    guard let value, CFGetTypeID(value) == AXValueGetTypeID() else { return nil }
    let axValue = value as! AXValue
    var size = CGSize.zero
    return AXValueGetType(axValue) == .cgSize && AXValueGetValue(axValue, .cgSize, &size)
      ? size : nil
  }

  static func range(_ value: CFTypeRef?) -> CFRange? {
    guard let value, CFGetTypeID(value) == AXValueGetTypeID() else { return nil }
    let axValue = value as! AXValue
    var range = CFRange(location: 0, length: 0)
    return AXValueGetType(axValue) == .cfRange && AXValueGetValue(axValue, .cfRange, &range)
      ? range : nil
  }

  static func frame(_ attributes: [String: CFTypeRef]) -> CGRect? {
    guard let origin = point(attributes[kAXPositionAttribute]),
      let size = size(attributes[kAXSizeAttribute]), size.width.isFinite, size.height.isFinite
    else { return nil }
    return CGRect(origin: origin, size: size)
  }

  static func frame(_ element: AXUIElement) -> CGRect? {
    frame(fetch(element, [kAXPositionAttribute, kAXSizeAttribute]))
  }

  static func pid(_ element: AXUIElement) -> pid_t? {
    var pid: pid_t = 0
    return AXUIElementGetPid(element, &pid) == .success && pid > 0 ? pid : nil
  }

  static func windowNumber(_ window: AXUIElement) -> CGWindowID? {
    var identifier: CGWindowID = 0
    return axWindowNumber(window, &identifier) == .success && identifier != 0 ? identifier : nil
  }

  static func actions(_ element: AXUIElement) -> [String] {
    var names: CFArray?
    guard AXUIElementCopyActionNames(element, &names) == .success, let list = names as? [String]
    else { return [] }
    return list
  }

  static func settable(_ element: AXUIElement, _ attribute: String) -> Bool {
    var result = DarwinBoolean(false)
    return AXUIElementIsAttributeSettable(element, attribute as CFString, &result) == .success
      && result.boolValue
  }

  @discardableResult
  static func set(_ element: AXUIElement, _ attribute: String, _ value: CFTypeRef) -> Bool {
    AXUIElementSetAttributeValue(element, attribute as CFString, value) == .success
  }

  static func application(_ pid: pid_t) -> AXUIElement {
    let app = AXUIElementCreateApplication(pid)
    // An unresponsive application must not stall input verification.
    AXUIElementSetMessagingTimeout(app, 0.75)
    return app
  }

  static func focusedApplication() -> (pid: pid_t, element: AXUIElement)? {
    guard let app = element(copy(systemWide, kAXFocusedApplicationAttribute)),
      let pid = pid(app)
    else { return nil }
    AXUIElementSetMessagingTimeout(app, 0.75)
    return (pid, app)
  }

  static func focusedWindow(_ app: AXUIElement) -> AXUIElement? {
    element(copy(app, kAXFocusedWindowAttribute)) ?? element(copy(app, kAXMainWindowAttribute))
  }

  static func focusedElement(_ app: AXUIElement) -> AXUIElement? {
    element(copy(app, kAXFocusedUIElementAttribute))
  }

  static func elementAt(_ point: CGPoint) -> AXUIElement? {
    var hit: AXUIElement?
    guard
      AXUIElementCopyElementAtPosition(systemWide, Float(point.x), Float(point.y), &hit)
        == .success
    else { return nil }
    return hit
  }

  static func parent(_ element: AXUIElement) -> AXUIElement? {
    self.element(copy(element, kAXParentAttribute))
  }

  /// True when `element` is `ancestor` or lies inside it (bounded walk).
  static func within(_ element: AXUIElement, _ ancestor: AXUIElement, depth: Int = 16) -> Bool {
    var current: AXUIElement? = element
    for _ in 0..<depth {
      guard let node = current else { return false }
      if CFEqual(node, ancestor) { return true }
      current = parent(node)
    }
    return false
  }

  static func role(_ element: AXUIElement) -> String { string(copy(element, kAXRoleAttribute)) ?? "" }
}

// MARK: - Roles

/// UI Automation control type names for macOS roles, so the shared JavaScript
/// observation rules (editable fields, clickable controls, captions) apply unchanged.
func controlType(role: String, subrole: String) -> String {
  let name: String
  switch role {
  case "AXButton", "AXPopUpButton", "AXMenuButton", "AXDisclosureTriangle", "AXColorWell":
    name = "Button"
  case "AXLink": name = "Hyperlink"
  case "AXRadioButton": name = subrole == "AXTabButton" ? "TabItem" : "RadioButton"
  case "AXCheckBox": name = "CheckBox"
  case "AXMenuItem", "AXMenuBarItem": name = "MenuItem"
  case "AXMenu": name = "Menu"
  case "AXMenuBar": name = "MenuBar"
  case "AXRow": name = subrole == "AXOutlineRow" ? "TreeItem" : "DataItem"
  case "AXCell": name = "DataItem"
  case "AXDockItem": name = "ListItem"
  case "AXTextField", "AXTextArea", "AXDateField": name = "Edit"
  case "AXComboBox": name = "ComboBox"
  case "AXStaticText", "AXHeading": name = "Text"
  case "AXImage": name = "Image"
  case "AXSlider": name = "Slider"
  case "AXWebArea": name = "Document"
  case "AXGroup", "AXRadioGroup": name = "Group"
  case "AXSplitGroup", "AXScrollArea", "AXLayoutArea", "AXDrawer", "AXBrowser": name = "Pane"
  case "AXToolbar": name = "ToolBar"
  case "AXWindow", "AXSheet", "AXApplication": name = "Window"
  case "AXList": name = "List"
  case "AXTable", "AXGrid": name = "DataGrid"
  case "AXOutline": name = "Tree"
  case "AXTabGroup": name = "Tab"
  case "AXProgressIndicator", "AXBusyIndicator", "AXLevelIndicator": name = "ProgressBar"
  case "AXIncrementor": name = "Spinner"
  case "AXScrollBar": name = "ScrollBar"
  case "AXValueIndicator", "AXSplitter": name = "Thumb"
  case "AXHelpTag": name = "ToolTip"
  case "AXColumn": name = "HeaderItem"
  default: name = "Custom"
  }
  return "ControlType." + name
}

let pointerControlTypes: Set<String> = [
  "ControlType.Button", "ControlType.Hyperlink", "ControlType.TabItem", "ControlType.MenuItem",
  "ControlType.CheckBox", "ControlType.RadioButton", "ControlType.ListItem",
  "ControlType.TreeItem", "ControlType.DataItem",
]

let browserBundles: Set<String> = [
  "com.apple.Safari", "com.apple.SafariTechnologyPreview", "com.google.Chrome",
  "com.google.Chrome.canary", "com.google.Chrome.beta", "com.brave.Browser",
  "com.microsoft.edgemac", "org.mozilla.firefox", "company.thebrowser.Browser",
  "com.vivaldi.Vivaldi", "com.operasoftware.Opera", "org.chromium.Chromium",
]

func bundleIdentifier(_ pid: pid_t) -> String? {
  NSRunningApplication(processIdentifier: pid)?.bundleIdentifier
}

// MARK: - Windows and displays (CoreGraphics; no Accessibility required)

struct WindowInfo {
  let id: CGWindowID
  let pid: pid_t
  let layer: Int
  let bounds: CGRect
  let alpha: Double
  let ownerName: String
}

/// On-screen windows, front to back. Titles are never read here.
func windowList(onScreenOnly: Bool = true) -> [WindowInfo] {
  let options: CGWindowListOption =
    onScreenOnly ? [.optionOnScreenOnly, .excludeDesktopElements] : [.optionAll]
  guard let list = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]]
  else { return [] }
  return list.compactMap { entry in
    guard let id = (entry[kCGWindowNumber as String] as? NSNumber)?.uint32Value,
      let pid = (entry[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value,
      let boundsValue = entry[kCGWindowBounds as String] as? NSDictionary,
      let bounds = CGRect(dictionaryRepresentation: boundsValue as CFDictionary)
    else { return nil }
    return WindowInfo(
      id: id, pid: pid,
      layer: (entry[kCGWindowLayer as String] as? NSNumber)?.intValue ?? 0,
      bounds: bounds,
      alpha: (entry[kCGWindowAlpha as String] as? NSNumber)?.doubleValue ?? 1,
      ownerName: entry[kCGWindowOwnerName as String] as? String ?? "")
  }
}

func windowInfo(_ id: CGWindowID) -> WindowInfo? {
  guard
    let list = CGWindowListCopyWindowInfo([.optionIncludingWindow], id) as? [[String: Any]],
    let entry = list.first,
    let pid = (entry[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value,
    let boundsValue = entry[kCGWindowBounds as String] as? NSDictionary,
    let bounds = CGRect(dictionaryRepresentation: boundsValue as CFDictionary)
  else { return nil }
  return WindowInfo(
    id: id, pid: pid, layer: (entry[kCGWindowLayer as String] as? NSNumber)?.intValue ?? 0,
    bounds: bounds, alpha: (entry[kCGWindowAlpha as String] as? NSNumber)?.doubleValue ?? 1,
    ownerName: entry[kCGWindowOwnerName as String] as? String ?? "")
}

/// Active displays in global top-left points.
func displays() -> [(id: CGDirectDisplayID, bounds: CGRect)] {
  var count: UInt32 = 0
  guard CGGetActiveDisplayList(0, nil, &count) == .success, count > 0 else { return [] }
  var ids = [CGDirectDisplayID](repeating: 0, count: Int(count))
  guard CGGetActiveDisplayList(count, &ids, &count) == .success else { return [] }
  return ids.prefix(Int(count)).map { ($0, CGDisplayBounds($0)) }
}

/// The display that holds most of `rect` (the main display when it is off screen).
func display(for rect: CGRect) -> (id: CGDirectDisplayID, bounds: CGRect)? {
  let all = displays()
  var best: (id: CGDirectDisplayID, bounds: CGRect)?
  var bestArea: CGFloat = 0
  for candidate in all {
    let overlap = candidate.bounds.intersection(rect)
    let area = overlap.isNull ? 0 : overlap.width * overlap.height
    if area > bestArea {
      best = candidate
      bestArea = area
    }
  }
  if let best { return best }
  let center = CGPoint(x: rect.midX, y: rect.midY)
  return all.first(where: { $0.bounds.contains(center) })
    ?? all.first(where: { $0.id == CGMainDisplayID() }) ?? all.first
}

func desktopBounds() -> CGRect {
  displays().reduce(CGRect.null) { $0.union($1.bounds) }
}

func rectJSON(_ rect: CGRect) -> JSON {
  [
    "x": Int(rect.origin.x.rounded(.down)), "y": Int(rect.origin.y.rounded(.down)),
    "width": Int(rect.width.rounded()), "height": Int(rect.height.rounded()),
  ]
}

// MARK: - Foreground

/// The process that receives keyboard input now. Accessibility gives the live
/// answer; without it NSWorkspace is refreshed by running the run loop briefly.
func frontmostPid() -> pid_t? {
  if AX.trusted(), let app = AX.focusedApplication() { return app.pid }
  RunLoop.current.run(mode: .default, before: Date())
  return NSWorkspace.shared.frontmostApplication?.processIdentifier
}

/// The CoreGraphics number of the window that has focus. With Accessibility this
/// is the focused window of the focused app; otherwise its frontmost normal window.
func foregroundWindowNumber() -> (pid: pid_t, window: CGWindowID?)? {
  if AX.trusted(), let app = AX.focusedApplication() {
    guard let window = AX.focusedWindow(app.element) else { return (app.pid, nil) }
    return (app.pid, AX.windowNumber(window) ?? matchWindowNumber(app.pid, window))
  }
  guard let pid = frontmostPid() else { return nil }
  let window = windowList().first(where: { $0.pid == pid && $0.layer == 0 && $0.alpha > 0 })
  return (pid, window?.id)
}

/// Fallback when the window number SPI is unavailable: same owner and frame.
func matchWindowNumber(_ pid: pid_t, _ window: AXUIElement) -> CGWindowID? {
  guard let frame = AX.frame(window) else { return nil }
  return windowList().first(where: {
    $0.pid == pid && $0.layer == 0 && abs($0.bounds.minX - frame.minX) <= 1
      && abs($0.bounds.minY - frame.minY) <= 1 && abs($0.bounds.width - frame.width) <= 1
      && abs($0.bounds.height - frame.height) <= 1
  })?.id
}
