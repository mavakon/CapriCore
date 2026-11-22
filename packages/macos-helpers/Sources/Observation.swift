// SPDX-License-Identifier: GPL-3.0-only
// Bounded Accessibility tree walks for computer control. Element identities are
// derived from the live tree (child-index path plus a fingerprint of role and
// label), so a control that moved or changed is reported stale, never guessed.
import AppKit
import ApplicationServices

private let observedAttributes: [String] = [
  kAXRoleAttribute, kAXSubroleAttribute, kAXTitleAttribute, kAXDescriptionAttribute,
  kAXEnabledAttribute, kAXPositionAttribute, kAXSizeAttribute, kAXIdentifierAttribute,
  kAXChildrenAttribute, kAXSelectedAttribute, "AXDOMIdentifier",
]
/// Value attributes are read only for roles that carry text, which keeps large
/// documents and lists from being copied for every element.
private let valueAttributes: [String] = [
  kAXValueAttribute, kAXPlaceholderValueAttribute, "AXURL", kAXTitleUIElementAttribute,
]
private let valueRoles: Set<String> = [
  "AXStaticText", "AXHeading", "AXTextField", "AXTextArea", "AXComboBox", "AXDateField",
  "AXLink", "AXWebArea", "AXRadioButton",
]
let editableRoles: Set<String> = ["AXTextField", "AXTextArea", "AXComboBox"]

final class AXNode {
  let element: AXUIElement
  let path: String
  let parent: AXNode?
  let attributes: [String: CFTypeRef]
  let role: String
  let subrole: String
  let type: String
  /// Inside (or itself) a web document, like UI Automation's Document ancestor.
  let inWeb: Bool
  /// A web document nested inside another one (an iframe).
  let nestedWeb: Bool
  let inToolbar: Bool

  init(element: AXUIElement, path: String, parent: AXNode?, attributes: [String: CFTypeRef]? = nil) {
    self.element = element
    self.path = path
    self.parent = parent
    let attributes = attributes ?? AX.fetch(element, observedAttributes)
    self.attributes = attributes
    role = AX.string(attributes[kAXRoleAttribute]) ?? ""
    subrole = AX.string(attributes[kAXSubroleAttribute]) ?? ""
    type = controlType(role: role, subrole: subrole)
    let web = role == "AXWebArea"
    nestedWeb = web && (parent?.inWeb ?? false)
    inWeb = web || (parent?.inWeb ?? false)
    inToolbar = role == "AXToolbar" || (parent?.inToolbar ?? false)
  }

  lazy var values: [String: CFTypeRef] =
    valueRoles.contains(role) ? AX.fetch(element, valueAttributes) : [:]
  lazy var frame: CGRect? = AX.frame(attributes)
  lazy var actions: [String] = AX.actions(element)
  var children: [AXUIElement] { AX.elements(attributes[kAXChildrenAttribute]) }
  var enabled: Bool { AX.boolean(attributes[kAXEnabledAttribute]) ?? true }
  var secure: Bool { subrole == "AXSecureTextField" }
  var identifier: String {
    AX.string(attributes[kAXIdentifierAttribute]) ?? AX.string(attributes["AXDOMIdentifier"]) ?? ""
  }
  var domIdentifier: String { AX.string(attributes["AXDOMIdentifier"]) ?? "" }
  var stringValue: String? { AX.string(values[kAXValueAttribute]) }
  var url: String? {
    guard let value = values["AXURL"] else { return nil }
    if CFGetTypeID(value) == CFURLGetTypeID() { return (value as! CFURL as URL).absoluteString }
    return AX.string(value)
  }
  var selected: Bool? {
    if let selected = AX.boolean(attributes[kAXSelectedAttribute]) { return selected }
    if role == "AXRadioButton", let value = values[kAXValueAttribute],
      CFGetTypeID(value) == CFNumberGetTypeID()
    {
      return (value as? NSNumber)?.intValue == 1
    }
    return nil
  }
  var hasPress: Bool { actions.contains(kAXPressAction) }

  /// The accessible name, as UI Automation's Name would read it.
  lazy var name: String = {
    let trimmed = { (value: String?) -> String? in
      guard let value, !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
        return nil
      }
      return value
    }
    if let title = trimmed(AX.string(attributes[kAXTitleAttribute])) { return title }
    if let description = trimmed(AX.string(attributes[kAXDescriptionAttribute])) {
      return description
    }
    if role == "AXStaticText" || role == "AXHeading", let text = trimmed(stringValue) { return text }
    if editableRoles.contains(role) || role == "AXDateField" {
      if let label = AX.element(values[kAXTitleUIElementAttribute]),
        let text = trimmed(AX.string(AX.copy(label, kAXValueAttribute)))
          ?? trimmed(AX.string(AX.copy(label, kAXTitleAttribute)))
      {
        return text
      }
      if let placeholder = trimmed(AX.string(values[kAXPlaceholderValueAttribute])) {
        return placeholder
      }
    }
    return ""
  }()

  var fingerprint: String { role + "\u{0}" + subrole + "\u{0}" + identifier + "\u{0}" + name }

  /// Opaque control identity: `ax<path hash>.<fingerprint hash>`.
  func id(window: CGWindowID) -> String {
    "ax" + String(sha256Hex("\(window)|\(path)|\(role)|\(subrole)").prefix(20)) + "."
      + String(sha256Hex(fingerprint).prefix(12))
  }

  var editable: Bool {
    editableRoles.contains(role) && enabled && !secure
      && AX.settable(element, kAXValueAttribute)
  }
}

struct ControlIdentity {
  let path: String
  let fingerprint: String
  init?(_ id: String) {
    guard id.count == 35, id.hasPrefix("ax"), id[id.index(id.startIndex, offsetBy: 22)] == "."
    else { return nil }
    let body = id.dropFirst(2)
    let parts = body.split(separator: ".")
    guard parts.count == 2, parts[0].count == 20, parts[1].count == 12,
      parts.allSatisfy({ $0.allSatisfy { $0.isHexDigit && !$0.isUppercase } })
    else { return nil }
    path = String(parts[0])
    fingerprint = String(parts[1])
  }
  func matchesPath(_ node: AXNode, window: CGWindowID) -> Bool {
    String(sha256Hex("\(window)|\(node.path)|\(node.role)|\(node.subrole)").prefix(20)) == path
  }
  func matchesFingerprint(_ node: AXNode) -> Bool {
    String(sha256Hex(node.fingerprint).prefix(12)) == fingerprint
  }
}

/// Breadth-first, bounded by element count and time, as the Windows helper does.
/// The root itself is not visited. `visit` returns false to stop early.
func walk(
  root: AXNode, limit: Int, timeoutMs: Double, visit: (AXNode) -> Bool
) {
  var queue: [AXNode] = [root]
  var head = 0
  var count = 0
  let started = nowMs()
  while head < queue.count, count < limit, nowMs() - started < timeoutMs {
    let parent = queue[head]
    head += 1
    for (index, child) in parent.children.enumerated() {
      if count >= limit || nowMs() - started >= timeoutMs { return }
      count += 1
      let node = AXNode(element: child, path: parent.path + "/" + String(index), parent: parent)
      if !visit(node) { return }
      queue.append(node)
    }
  }
}

/// The observed window and any open menus of the same application.
func observedNodes(
  app: AXUIElement, window: AXUIElement, limit: Int = 800, timeoutMs: Double = 2000,
  visit: (AXNode) -> Bool
) {
  var stopped = false
  let root = AXNode(element: window, path: "w", parent: nil)
  walk(root: root, limit: limit, timeoutMs: timeoutMs) { node in
    if !visit(node) { stopped = true }
    return !stopped
  }
  if stopped { return }
  let menus = AX.elements(AX.copy(app, kAXChildrenAttribute)).filter { AX.role($0) == "AXMenu" }
  for (index, menu) in menus.prefix(4).enumerated() {
    let menuRoot = AXNode(element: menu, path: "m" + String(index), parent: nil)
    if !visit(menuRoot) { return }
    walk(root: menuRoot, limit: 80, timeoutMs: 300) { node in
      if !visit(node) { stopped = true }
      return !stopped
    }
    if stopped { return }
  }
}

/// Finds an observed control again. The exact path must still hold the same
/// role and label; otherwise only a unique element with the same fingerprint
/// at the observed position (when one is given) is accepted.
func findNode(
  _ id: String, app: AXUIElement, window: AXUIElement, windowNumber: CGWindowID,
  near point: CGPoint? = nil
) -> AXNode? {
  guard let identity = ControlIdentity(id) else { return nil }
  var exact: AXNode?
  var candidates: [AXNode] = []
  observedNodes(app: app, window: window) { node in
    guard identity.matchesFingerprint(node) else { return true }
    if identity.matchesPath(node, window: windowNumber) {
      exact = node
      return false
    }
    if candidates.count < 2, let point, let frame = node.frame, frame.contains(point) {
      candidates.append(node)
    }
    return true
  }
  if let exact { return exact }
  return candidates.count == 1 ? candidates[0] : nil
}

// MARK: - Semantics shared with the Windows observation

/// A text label inside an actionable control (a button caption, a link text).
func captionControl(_ label: AXNode) -> AXNode? {
  guard label.type == "ControlType.Text", let box = label.frame else { return nil }
  var parent = label.parent
  for _ in 0..<4 {
    guard let control = parent else { return nil }
    guard control.enabled, let bounds = control.frame, bounds.insetBy(dx: -0.5, dy: -0.5).contains(box)
    else { return nil }
    if pointerControlTypes.contains(control.type) || control.hasPress { return control }
    if !["ControlType.Custom", "ControlType.Group", "ControlType.Pane"].contains(control.type) {
      return nil
    }
    parent = control.parent
  }
  return nil
}

/// A short label tightly wrapped by an unnamed generic container (web buttons
/// drawn with divs). Clicking it is offered only as a visually confirmed caption.
func compactCaptionBounds(_ label: AXNode) -> CGRect? {
  guard label.type == "ControlType.Text", !label.name.trimmingCharacters(in: .whitespaces).isEmpty,
    label.name.utf16.count <= 100, let box = label.frame, box.width > 0, box.height > 0,
    let wrapper = label.parent, ["ControlType.Custom", "ControlType.Group"].contains(wrapper.type),
    wrapper.name.trimmingCharacters(in: .whitespaces).isEmpty, wrapper.enabled,
    let bounds = wrapper.frame, bounds.contains(box), bounds.width >= box.width + 6,
    bounds.height >= box.height + 4, bounds.width <= box.width * 3,
    bounds.height <= box.height * 3
  else { return nil }
  return bounds
}

func containingLink(_ node: AXNode) -> String {
  var current: AXNode? = node
  for _ in 0..<10 {
    guard let element = current else { break }
    if element.type == "ControlType.Document" { break }
    if element.role == "AXLink", let url = element.url { return clean(url, 2048) }
    current = element.parent
  }
  return ""
}

func isBrowser(_ pid: pid_t) -> Bool { browserBundles.contains(bundleIdentifier(pid) ?? "") }

/// The browser's own address field: outside every web document, in its toolbar.
func browserAddressField(_ node: AXNode, browser: Bool) -> Bool {
  guard browser, !node.inWeb else { return false }
  return node.inToolbar || node.identifier.localizedCaseInsensitiveContains("address")
    || node.identifier == "WEB_BROWSER_ADDRESS_AND_SEARCH_FIELD"
}

/// The address of the browser's top-level page (never an iframe or a link).
func browserDocumentAddress(_ node: AXNode, browser: Bool) -> String? {
  guard browser, node.role == "AXWebArea", !node.nestedWeb, let value = node.url,
    value.utf16.count <= 2048, let url = URL(string: value),
    ["http", "https"].contains(url.scheme?.lowercased() ?? ""), url.user == nil, url.password == nil
  else { return nil }
  return url.absoluteString
}

func webSearchField(_ node: AXNode) -> Bool {
  matches(node.domIdentifier.isEmpty ? node.identifier : node.domIdentifier,
    "^(?:q|search|searchbox|APjFqb|store_nav_search_term)$", caseInsensitive: true)
    || matches(
      node.name,
      "^(?:search|search query|search Google|search the web|search (?:the )?store|поиск по магазину|поиск|найти|поисковый запрос|suchen|rechercher|buscar|cerca|pesquisar|szukaj|пошук|بحث|搜索|検索|검색)$",
      caseInsensitive: true)
}

let secretLabel = "password|token|secret|api.?key|парол|секрет"
