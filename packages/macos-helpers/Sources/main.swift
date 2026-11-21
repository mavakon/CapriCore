// SPDX-License-Identifier: GPL-3.0-only
// Capri's macOS helper: one binary, one subcommand per Windows helper. With no
// subcommand it is the computer-control bridge (one JSON request on stdin), as
// Capri.DesktopActions.exe is on Windows.
import Foundation

let helperVersion = 1

private func helperMain() -> Int32 {
  let command = Array(CommandLine.arguments.dropFirst())
  let rest = Array(command.dropFirst())
  switch command.first {
  case nil, "desktop-actions": return runDesktopActions()
  case "screen-worker": return runScreenWorker()
  case "screen-capture": return runScreenCapture(rest)
  case "window-events": return runWindowEvents()
  case "spotify": return runSpotify()
  case "audio-endpoints": return runAudioEndpoints(rest)
  case "gpu": return runGpu()
  case "tool-sandbox": return runToolSandbox(rest)
  case "permissions": return runPermissions(rest)
  case "version":
    Output.line(["ok": true, "helper": "capri-macos", "version": helperVersion])
    return 0
  default:
    FileHandle.standardError.write(Data("Unknown Capri helper command.\n".utf8))
    return 2
  }
}

exit(helperMain())
