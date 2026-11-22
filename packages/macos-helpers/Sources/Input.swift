// SPDX-License-Identifier: GPL-3.0-only
// Synthetic keyboard and pointer input through CoreGraphics events.
// Key names are the Windows names the shared JavaScript validates. On macOS
// CTRL is the Command key (copy, paste, address bar, save), WIN is Control.
import AppKit
import CoreGraphics

enum Keys {
  static let command: CGKeyCode = 0x37
  static let shift: CGKeyCode = 0x38
  static let option: CGKeyCode = 0x3A
  static let control: CGKeyCode = 0x3B
  static let escape: CGKeyCode = 0x35
  static let returnKey: CGKeyCode = 0x24
  static let letterA: CGKeyCode = 0x00
  static let letterL: CGKeyCode = 0x25
  static let downArrow: CGKeyCode = 0x7D

  private static let letters: [Character: CGKeyCode] = [
    "A": 0x00, "S": 0x01, "D": 0x02, "F": 0x03, "H": 0x04, "G": 0x05, "Z": 0x06, "X": 0x07,
    "C": 0x08, "V": 0x09, "B": 0x0B, "Q": 0x0C, "W": 0x0D, "E": 0x0E, "R": 0x0F, "Y": 0x10,
    "T": 0x11, "1": 0x12, "2": 0x13, "3": 0x14, "4": 0x15, "6": 0x16, "5": 0x17, "9": 0x19,
    "7": 0x1A, "8": 0x1C, "0": 0x1D, "O": 0x1F, "U": 0x20, "I": 0x22, "P": 0x23, "L": 0x25,
    "J": 0x26, "K": 0x28, "N": 0x2D, "M": 0x2E,
  ]
  private static let functionKeys: [Int: CGKeyCode] = [
    1: 0x7A, 2: 0x78, 3: 0x63, 4: 0x76, 5: 0x60, 6: 0x61, 7: 0x62, 8: 0x64, 9: 0x65, 10: 0x6D,
    11: 0x67, 12: 0x6F, 13: 0x69, 14: 0x6B, 15: 0x71, 16: 0x6A, 17: 0x40, 18: 0x4F, 19: 0x50,
    20: 0x5A,
  ]
  private static let named: [String: CGKeyCode] = [
    "CTRL": command, "SHIFT": shift, "ALT": option, "WIN": control, "ENTER": returnKey,
    "TAB": 0x30, "SPACE": 0x31, "BACKSPACE": 0x33, "DELETE": 0x75, "INSERT": 0x72,
    "HOME": 0x73, "END": 0x77, "PAGEUP": 0x74, "PAGEDOWN": 0x79, "LEFT": 0x7B, "UP": 0x7E,
    "RIGHT": 0x7C, "DOWN": downArrow, "ESCAPE": escape,
  ]

  static func code(_ raw: String) throws -> CGKeyCode {
    let name = raw.uppercased()
    if name.count == 1, let character = name.first, let code = letters[character] { return code }
    if name.hasPrefix("F"), let number = Int(name.dropFirst()), (1...24).contains(number),
      String(number) == String(name.dropFirst())
    {
      guard let code = functionKeys[number] else {
        throw HelperError("macOS has no \(name) key.")
      }
      return code
    }
    guard let code = named[name] else { throw HelperError("Unsupported keyboard key.") }
    return code
  }

  static func modifierFlag(_ code: CGKeyCode) -> CGEventFlags? {
    switch code {
    case command: return .maskCommand
    case shift: return .maskShift
    case option: return .maskAlternate
    case control: return .maskControl
    default: return nil
    }
  }
}

/// Posts events at the HID level so they reach the application under the
/// pointer or with keyboard focus, as a physical device would.
final class Injector {
  private let source = CGEventSource(stateID: .hidSystemState)
  private(set) var heldFlags: CGEventFlags = []

  private func post(_ event: CGEvent?) throws {
    guard let event else { throw HelperError("macOS rejected synthetic input.") }
    event.post(tap: .cghidEventTap)
  }

  func key(_ code: CGKeyCode, down: Bool) throws {
    guard let event = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: down) else {
      throw HelperError("macOS rejected synthetic input.")
    }
    if let flag = Keys.modifierFlag(code) {
      if down { heldFlags.insert(flag) } else { heldFlags.remove(flag) }
      event.type = .flagsChanged
    }
    event.flags = heldFlags
    try post(event)
  }

  /// Unicode text, one character per key event pair, independent of the layout.
  func type(_ text: String) throws {
    var count = 0
    for character in text {
      let units = Array(String(character).utf16)
      for down in [true, false] {
        guard let event = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: down)
        else { throw HelperError("macOS received incomplete text input. Check the field before retrying.") }
        event.flags = []
        units.withUnsafeBufferPointer {
          event.keyboardSetUnicodeString(stringLength: $0.count, unicodeString: $0.baseAddress)
        }
        try post(event)
      }
      count += 1
      // Let the target drain its event queue during long text.
      if count % 40 == 0 { sleepMs(4) }
    }
  }

  static func location() -> CGPoint { CGEvent(source: nil)?.location ?? .zero }

  func move(to point: CGPoint, dragging: Bool = false) throws {
    let type: CGEventType = dragging ? .leftMouseDragged : .mouseMoved
    let event = CGEvent(
      mouseEventSource: source, mouseType: type, mouseCursorPosition: point, mouseButton: .left)
    event?.flags = heldFlags
    try post(event)
  }

  func button(_ name: String, down: Bool, at point: CGPoint, clickState: Int64 = 1) throws {
    let (type, button): (CGEventType, CGMouseButton)
    switch name {
    case "right": (type, button) = (down ? .rightMouseDown : .rightMouseUp, .right)
    case "middle": (type, button) = (down ? .otherMouseDown : .otherMouseUp, .center)
    default: (type, button) = (down ? .leftMouseDown : .leftMouseUp, .left)
    }
    guard
      let event = CGEvent(
        mouseEventSource: source, mouseType: type, mouseCursorPosition: point, mouseButton: button)
    else { throw HelperError("macOS rejected synthetic input.") }
    event.setIntegerValueField(.mouseEventClickState, value: clickState)
    event.flags = heldFlags
    try post(event)
  }

  /// Positive amounts scroll up, as a Windows wheel notch does.
  func scroll(_ amount: Int) throws {
    let event = CGEvent(
      scrollWheelEvent2Source: source, units: .line, wheelCount: 1, wheel1: Int32(amount * 3),
      wheel2: 0, wheel3: 0)
    event?.flags = heldFlags
    try post(event)
  }
}

/// Physical mouse buttons or modifier keys are held. Input must not mix with them.
func userInputBusy() -> Bool {
  for button in [CGMouseButton.left, .right, .center]
  where CGEventSource.buttonState(.hidSystemState, button: button) {
    return true
  }
  let flags = CGEventSource.flagsState(.hidSystemState)
  return !flags.intersection([.maskCommand, .maskControl, .maskAlternate, .maskShift]).isEmpty
}

func doubleClickIntervalMs() -> Double { NSEvent.doubleClickInterval * 1000 }
