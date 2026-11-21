// SPDX-License-Identifier: GPL-3.0-only
// Shared plumbing for Capri's macOS helper: bounded JSON over stdio, process
// identity and small text utilities. No helper writes logs or reads user files.
import CryptoKit
import Darwin
import Foundation

typealias JSON = [String: Any]

/// A failure reported to the caller as `{ok:false,error}`. A preflight failure
/// guarantees that no input reached another application (`inputPerformed:false`).
struct HelperError: Error {
  let message: String
  let code: String?
  let preflight: Bool
  init(_ message: String, code: String? = nil, preflight: Bool = false) {
    self.message = message
    self.code = code
    self.preflight = preflight
  }
  static func before(_ code: String, _ message: String) -> HelperError {
    HelperError(message, code: code, preflight: true)
  }
}

enum Output {
  private static let lock = NSLock()
  static func data(_ value: Any) -> Data {
    let sanitized = sanitize(value)
    guard JSONSerialization.isValidJSONObject(sanitized),
      let data = try? JSONSerialization.data(
        withJSONObject: sanitized, options: [.withoutEscapingSlashes])
    else { return Data("{\"ok\":false,\"error\":\"Invalid helper response.\"}".utf8) }
    return data
  }
  /// One JSON document per line on stdout, written atomically.
  static func line(_ value: Any) {
    var bytes = data(value)
    bytes.append(0x0A)
    raw(bytes)
  }
  static func raw(_ bytes: Data) {
    lock.lock()
    defer { lock.unlock() }
    bytes.withUnsafeBytes { buffer in
      var offset = 0
      while offset < buffer.count {
        let written = Darwin.write(1, buffer.baseAddress! + offset, buffer.count - offset)
        if written < 0 {
          if errno == EINTR { continue }
          exit(1)
        }
        offset += written
      }
    }
  }
  /// JSONSerialization rejects NaN and infinities; they never leave the helper.
  private static func sanitize(_ value: Any) -> Any {
    switch value {
    case let dictionary as [String: Any]:
      return dictionary.mapValues { sanitize($0) }
    case let array as [Any]:
      return array.map { sanitize($0) }
    case let number as Double:
      return number.isFinite ? number : NSNull()
    case let number as Float:
      return number.isFinite ? Double(number) : NSNull()
    default:
      return value
    }
  }
}

func failure(_ error: Error) -> JSON {
  if let error = error as? HelperError {
    var result: JSON = ["ok": false, "error": clean(error.message, 320)]
    if let code = error.code { result["errorCode"] = code }
    if error.preflight { result["inputPerformed"] = false }
    return result
  }
  return ["ok": false, "error": "The macOS helper could not complete the request."]
}

/// Reads one bounded line from stdin. Returns nil at end of input.
func readRequestLine(limit: Int) -> String? {
  guard let line = readLine(strippingNewline: true) else { return nil }
  if line.utf8.count > limit { return nil }
  return line.hasSuffix("\r") ? String(line.dropLast()) : line
}

func parseObject(_ line: String) throws -> JSON {
  guard let data = line.data(using: .utf8),
    let value = try? JSONSerialization.jsonObject(with: data),
    let object = value as? JSON
  else { throw HelperError("Invalid request.") }
  return object
}

func isBoolean(_ value: Any?) -> Bool {
  guard let number = value as? NSNumber else { return false }
  return CFGetTypeID(number) == CFBooleanGetTypeID()
}

func text(_ q: JSON, _ key: String) -> String { q[key] as? String ?? "" }

func bool(_ q: JSON, _ key: String) -> Bool? {
  isBoolean(q[key]) ? (q[key] as! NSNumber).boolValue : nil
}

/// Integers from JSON numbers or decimal strings, as Windows Convert.ToInt32 accepted.
func integer(_ q: JSON, _ key: String) -> Int? {
  if let number = q[key] as? NSNumber, !isBoolean(number) {
    let value = number.doubleValue
    guard value.isFinite, value.rounded() == value, abs(value) < 9.0e15 else { return nil }
    return Int(value)
  }
  if let string = q[key] as? String, string.count <= 20, let value = Int(string) { return value }
  return nil
}

func number(_ q: JSON, _ key: String) -> Double? {
  guard let number = q[key] as? NSNumber, !isBoolean(number), number.doubleValue.isFinite
  else { return nil }
  return number.doubleValue
}

/// Truncates by UTF-16 code units (JavaScript string length) without splitting a pair.
func clean(_ value: String?, _ limit: Int) -> String {
  guard let value else { return "" }
  if value.utf16.count <= limit { return value }
  var result = ""
  var used = 0
  for character in value {
    let size = character.utf16.count
    if used + size > limit { break }
    result.append(character)
    used += size
  }
  return result
}

func sha256Hex(_ value: String) -> String {
  SHA256.hash(data: Data(value.utf8)).map { String(format: "%02x", $0) }.joined()
}

func nowMs() -> Double { Double(DispatchTime.now().uptimeNanoseconds) / 1_000_000 }

func sleepMs(_ milliseconds: Double) {
  if milliseconds > 0 { usleep(useconds_t(min(milliseconds, 60_000) * 1000)) }
}

func matches(_ value: String, _ pattern: String, caseInsensitive: Bool = false) -> Bool {
  value.range(
    of: pattern, options: caseInsensitive ? [.regularExpression, .caseInsensitive] : .regularExpression)
    != nil
}

// MARK: - Process identity

/// Process start time in .NET ticks (100 ns since 0001-01-01 UTC), the same
/// identity format the Windows helpers report, so the JavaScript checks stay shared.
func processStartTicks(_ pid: pid_t) -> String? {
  guard pid > 0 else { return nil }
  var info = kinfo_proc()
  var size = MemoryLayout<kinfo_proc>.stride
  var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, pid]
  guard sysctl(&mib, 4, &info, &size, nil, 0) == 0, size > 0, info.kp_proc.p_pid == pid
  else { return nil }
  let started = info.kp_proc.p_un.__p_starttime
  let ticks =
    Int64(started.tv_sec) * 10_000_000 + Int64(started.tv_usec) * 10 + 621_355_968_000_000_000
  return ticks > 0 ? String(ticks) : nil
}

func processPath(_ pid: pid_t) -> String? {
  guard pid > 0 else { return nil }
  var buffer = [CChar](repeating: 0, count: 4 * Int(MAXPATHLEN))
  let length = proc_pidpath(pid, &buffer, UInt32(buffer.count))
  guard length > 0 else { return nil }
  return buffer.withUnsafeBufferPointer { String(cString: $0.baseAddress!) }
}

func processExists(_ pid: pid_t) -> Bool {
  pid > 0 && (kill(pid, 0) == 0 || errno == EPERM)
}

/// Capri's own desktop, from source (Electron in this repository layout) or a
/// packaged Capri.app. Never a target of computer control.
func isCapriExecutable(_ file: String) -> Bool {
  let url = URL(fileURLWithPath: file).standardizedFileURL
  let components = url.pathComponents
  // The outermost bundle identifies the application; Electron helpers live inside it.
  if let app = components.firstIndex(where: { $0.hasSuffix(".app") }) {
    let bundle = NSString.path(withComponents: Array(components[...app]))
    if let info = NSDictionary(contentsOfFile: bundle + "/Contents/Info.plist") {
      if (info["CFBundleName"] as? String) == "Capri"
        || (info["CFBundleExecutable"] as? String) == "Capri"
      {
        return true
      }
    }
    // Source launches run Electron.app (or its helpers) from node_modules/electron/dist.
    if app >= 4, components[app - 1] == "dist", components[app - 2] == "electron",
      components[app - 3] == "node_modules"
    {
      let root = NSString.path(withComponents: Array(components[..<(app - 3)]))
      let package = root + "/package.json"
      guard FileManager.default.fileExists(atPath: root + "/apps/desktop/main.mjs"),
        let attributes = try? FileManager.default.attributesOfItem(atPath: package),
        let size = attributes[.size] as? NSNumber, size.intValue <= 65536,
        let data = FileManager.default.contents(atPath: package),
        let json = try? JSONSerialization.jsonObject(with: data) as? JSON
      else { return false }
      return (json["name"] as? String) == "capri"
    }
  }
  return false
}
