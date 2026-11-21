// SPDX-License-Identifier: GPL-3.0-only
// macOS privacy permissions as the helper sees them. macOS attributes them to
// the app that started Capri (Capri.app when packaged, the terminal when run
// from source). Checking never prompts; `request` asks macOS to show its prompt.
import ApplicationServices
import CoreGraphics

func permissionStatus() -> JSON {
  [
    "ok": true, "accessibility": AXIsProcessTrusted(), "screenRecording": CGPreflightScreenCaptureAccess(),
    "inputMonitoring": CGPreflightListenEventAccess(),
  ]
}

func runPermissions(_ arguments: [String]) -> Int32 {
  if arguments.isEmpty {
    Output.line(permissionStatus())
    return 0
  }
  guard arguments.count == 2, arguments[0] == "request" else { return 2 }
  switch arguments[1] {
  case "accessibility":
    let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
    _ = AXIsProcessTrustedWithOptions(options)
  case "screen-recording": _ = CGRequestScreenCaptureAccess()
  default: return 2
  }
  Output.line(permissionStatus())
  return 0
}
