// SPDX-License-Identifier: GPL-3.0-only
// Fixed Seatbelt launcher for explicitly approved user tools, the macOS
// counterpart of the Windows AppContainer launcher. No shell. The tool may read
// its code and runtime, write only its private output folder, start no other
// program, and reach the network only when its manifest allows it. Time, memory
// and output are bounded; the owner can cancel by writing a line or closing stdin.
import Darwin
import Foundation

private let memoryLimit: UInt64 = 256 * 1024 * 1024
private let outputLimit = 65536

private struct SandboxFailure: Error {
  let stage: String
  let code: Int32
}

/// A Scheme string literal for the Seatbelt profile.
private func literal(_ value: String) -> String {
  "\"" + value.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"")
    + "\""
}

private func ancestors(_ folder: String) -> [String] {
  var result: [String] = []
  var current = (folder as NSString).deletingLastPathComponent
  while !current.isEmpty {
    result.append(current)
    if current == "/" { break }
    current = (current as NSString).deletingLastPathComponent
  }
  return result
}

func sandboxProfile(
  code: String, runtime: String, output: String, executables: [String], network: Bool
) -> String {
  var parents = Set<String>()
  for folder in [code, runtime, output] { parents.formUnion(ancestors(folder)) }
  var lines = [
    "(version 1)",
    "(deny default)",
    "(import \"system.sb\")",
    "(allow process-exec "
      + Set(executables).sorted().map { "(literal \(literal($0)))" }.joined(separator: " ") + ")",
    "(allow file-read* (subpath \(literal(runtime))) (subpath \(literal(code))) (subpath \(literal(output))))",
    "(allow file-write* (subpath \(literal(output))))",
    "(allow file-read-metadata " + parents.sorted().map { "(literal \(literal($0)))" }.joined(separator: " ")
      + ")",
    "(allow file-read* (subpath \"/usr/share/zoneinfo\") (subpath \"/private/var/db/timezone\"))",
    "(allow sysctl-read)",
    "(allow signal (target self))",
  ]
  if network {
    lines += [
      "(allow network*)",
      "(allow system-socket)",
      "(allow mach-lookup (global-name \"com.apple.dnssd.service\") (global-name \"com.apple.SystemConfiguration.configd\") (global-name \"com.apple.trustd\") (global-name \"com.apple.trustd.agent\"))",
      "(allow file-read* (literal \"/private/etc/hosts\") (literal \"/private/etc/resolv.conf\") (literal \"/private/var/run/resolv.conf\") (literal \"/private/etc/services\") (literal \"/private/etc/protocols\"))",
    ]
  }
  return lines.joined(separator: "\n")
}

/// Absolute, normalized and free of links or control characters.
private func folder(_ q: JSON, _ key: String) throws -> String {
  let raw = text(q, key)
  guard raw.hasPrefix("/"), raw.utf8.count <= 1024,
    !raw.unicodeScalars.contains(where: { $0.value < 0x20 || $0.value == 0x7F })
  else { throw SandboxFailure(stage: "request", code: 0) }
  // Seatbelt matches resolved paths, so every folder must already be its real path.
  guard let resolved = realpath(raw, nil) else { throw SandboxFailure(stage: "request", code: 0) }
  defer { free(resolved) }
  guard String(cString: resolved) == raw else { throw SandboxFailure(stage: "request", code: 0) }
  return raw
}

private final class Bounded {
  private let lock = NSLock()
  private var data = Data()
  private(set) var tooLarge = false
  private let done = DispatchSemaphore(value: 0)
  init(_ handle: FileHandle) {
    Thread.detachNewThread { [self] in
      while true {
        let chunk = handle.availableData
        if chunk.isEmpty { break }
        lock.lock()
        if data.count + chunk.count > outputLimit { tooLarge = true } else { data.append(chunk) }
        lock.unlock()
      }
      done.signal()
    }
  }
  func wait(_ seconds: Double) -> Bool { done.wait(timeout: .now() + seconds) == .success }
  var text: String {
    lock.lock()
    defer { lock.unlock() }
    return String(decoding: data, as: UTF8.self)
  }
  var exceeded: Bool {
    lock.lock()
    defer { lock.unlock() }
    return tooLarge
  }
}

private func footprint(_ pid: pid_t) -> UInt64 {
  var usage = rusage_info_v2()
  let status = withUnsafeMutablePointer(to: &usage) {
    $0.withMemoryRebound(to: rusage_info_t?.self, capacity: 1) {
      proc_pid_rusage(pid, RUSAGE_INFO_V2, $0)
    }
  }
  return status == 0 ? usage.ri_phys_footprint : 0
}

func runToolSandbox(_ arguments: [String]) -> Int32 {
  if arguments.count == 2, arguments[0] == "--cleanup", matches(arguments[1], "^Capri\\.Tool\\.[a-f0-9]{24}$")
  {
    // Seatbelt keeps no per-tool profile on disk.
    return 0
  }
  var stage = "request"
  var process: Process?
  var cancelled = false
  let cancelLock = NSLock()
  do {
    guard arguments.isEmpty, let line = readRequestLine(limit: 524_288) else {
      throw SandboxFailure(stage: stage, code: 0)
    }
    let q = try parseObject(line)
    let code = try folder(q, "code")
    let output = try folder(q, "output")
    let runtime = try folder(q, "runtime")
    let executable = text(q, "executable")
    guard let timeout = integer(q, "timeoutMs"), timeout >= 100, timeout <= 60000,
      executable.hasPrefix(runtime + "/"),
      URL(fileURLWithPath: executable).standardizedFileURL.path == executable,
      FileManager.default.isExecutableFile(atPath: executable), let network = bool(q, "network"),
      let list = q["arguments"] as? [Any], list.count <= 64, let input = q["input"] as? String
    else { throw SandboxFailure(stage: stage, code: 0) }
    var toolArguments: [String] = []
    for item in list {
      guard let value = item as? String, !value.contains("\u{0}"), value.utf8.count <= 4096 else {
        throw SandboxFailure(stage: stage, code: 0)
      }
      toolArguments.append(value)
    }
    // A runtime may link its launcher (python3 -> python3.11); Seatbelt checks the target.
    guard let real = realpath(executable, nil) else { throw SandboxFailure(stage: stage, code: 0) }
    let target = String(cString: real)
    free(real)
    guard target.hasPrefix(runtime + "/") else { throw SandboxFailure(stage: stage, code: 0) }
    stage = "profile"
    let profile = sandboxProfile(
      code: code, runtime: runtime, output: output, executables: [executable, target],
      network: network)
    stage = "create"
    let child = Process()
    child.executableURL = URL(fileURLWithPath: "/usr/bin/sandbox-exec")
    child.arguments = ["-p", profile, executable] + toolArguments
    child.currentDirectoryURL = URL(fileURLWithPath: code)
    child.environment = [
      "HOME": output, "TMPDIR": output + "/", "PATH": runtime + ":/usr/bin:/bin",
      "LANG": "en_US.UTF-8", "PYTHONDONTWRITEBYTECODE": "1", "PYTHONIOENCODING": "utf-8",
      "PYTHONUTF8": "1",
    ]
    let stdin = Pipe()
    let stdout = Pipe()
    let stderr = Pipe()
    child.standardInput = stdin
    child.standardOutput = stdout
    child.standardError = stderr
    try child.run()
    process = child
    stage = "run"
    let read = Bounded(stdout.fileHandleForReading)
    let errors = Bounded(stderr.fileHandleForReading)
    Thread.detachNewThread {
      stdin.fileHandleForWriting.write(Data(input.utf8))
      try? stdin.fileHandleForWriting.close()
    }
    // The private launcher pipe also cancels on owner exit or EOF.
    Thread.detachNewThread {
      _ = readLine()
      cancelLock.lock()
      cancelled = true
      cancelLock.unlock()
    }
    let started = nowMs()
    var memory = false
    while child.isRunning {
      cancelLock.lock()
      let stop = cancelled
      cancelLock.unlock()
      memory = memory || footprint(child.processIdentifier) > memoryLimit
      if nowMs() - started > Double(timeout) || read.exceeded || errors.exceeded || stop || memory {
        kill(child.processIdentifier, SIGKILL)
        child.waitUntilExit()
        if memory {
          Output.line([
            "ok": false, "sandbox": "macos-seatbelt", "exitCode": 137, "reason": "memory_limit",
            "output": "",
          ])
          return 1
        }
        throw SandboxFailure(stage: stage, code: 0)
      }
      sleepMs(25)
    }
    let exit = child.terminationStatus
    guard read.wait(1), errors.wait(1), !read.exceeded, !errors.exceeded else {
      throw SandboxFailure(stage: stage, code: 0)
    }
    let diagnostic = errors.text
    let reason =
      diagnostic.contains("EACCES")
      ? "access_denied"
      : diagnostic.contains("EPERM") || diagnostic.contains("Operation not permitted")
        ? "operation_denied"
        : diagnostic.contains("Cannot find module") || diagnostic.contains("ERR_MODULE_NOT_FOUND")
          || diagnostic.contains("ModuleNotFoundError")
          ? "module_unavailable"
          : diagnostic.contains("ENOMEM") || diagnostic.contains("MemoryError") ? "memory_limit" : "tool_exit"
    Output.line([
      "ok": exit == 0 && child.terminationReason == .exit, "sandbox": "macos-seatbelt",
      "exitCode": Int(exit), "reason": reason, "output": read.text,
    ])
    return exit == 0 ? 0 : 1
  } catch {
    if let process, process.isRunning {
      kill(process.processIdentifier, SIGKILL)
      process.waitUntilExit()
    }
    let failure = error as? SandboxFailure
    Output.line([
      "ok": false, "stage": failure?.stage ?? stage, "code": Int(failure?.code ?? 0),
      "error": "The isolated tool failed, timed out or was blocked by macOS.",
    ])
    return 1
  }
}
