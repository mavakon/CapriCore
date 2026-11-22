# macOS (Apple silicon) — foundation

Capri's desktop runs from source on macOS with Apple silicon (arm64): text chat,
memory and the animated avatar, with local models on the Metal GPU or an
OpenAI-compatible API, plus computer control, screen capture, window awareness,
Spotify playback control, the user-tool sandbox and the GPU meter through a Swift
helper (see [Native helpers](#native-helpers)). Voice and a signed `.app`/`.dmg`
installer are separate follow-up work (see
[What is not done yet](#what-is-not-done-yet)).

## Run from source

Requirements: macOS on Apple silicon, Node.js 24.22.1 or a later 24.x (see
`.node-version`; `.npmrc` enforces the engine range), about 5 GB of free disk for
the default model, and a checkout in an ordinary folder under your home folder
(Capri refuses runtime paths that pass through symbolic links). The Swift helper
needs the Xcode command line tools (`xcode-select --install`); Xcode itself is not
required.

```sh
npm ci
npm run setup:macos   # pinned llama.cpp Metal build, Electron app bundle and the Swift helper, into .runtime/
npm run setup         # choose a profile from detected memory
npm run models:pull   # chat model + memory embedding model
npm run desktop
npm stop              # stops the desktop, the gateway and the model servers
```

If an older Node is installed system-wide, a private copy works: extract
`node-v24.22.1-darwin-arm64.tar.gz` from nodejs.org into
`.runtime/node-v24.22.1-darwin-arm64/` and put its `bin` folder first on `PATH`
for every `npm` command.

`CAPRI_DESKTOP_DEBUG=1 npm run desktop` shows the desktop's output in the
terminal, for diagnosing a startup failure. Normally that output is discarded to
keep conversation text out of logs.

## How the platform layer works

- `packages/runtime/src/host/platform.mjs` names every platform-specific runtime
  location: `.runtime/llama-<version>-macos-arm64/llama-server`,
  `.runtime/node-v<version>-darwin-arm64/bin/node` and
  `node_modules/electron/dist/Electron.app/Contents/MacOS/Electron`.
- `tools/setup/setup-macos.mjs` downloads the llama.cpp release pinned in
  `config/macos-runtime.json` (same build number as Windows, checked by SHA-256),
  copies the libraries llama-server loads through `@rpath` as regular files (the
  archive's symbolic links are resolved), and fetches Electron's app bundle, which
  Electron 45 otherwise downloads lazily on first use.
- llama.cpp on macOS links Metal and Accelerate directly, so the Windows
  per-worker DLL views are not used. Offload uses the existing `--fit` logic.
- Managed processes are identified by PID plus start time. macOS has no `/proc`,
  so the start time comes from `ps -o lstart` in UTC, stored as epoch seconds.
- Hardware detection reports the Apple GPU as `unified` memory with the Metal
  working-set limit (about two thirds of RAM, three quarters above 36 GiB).
  Profiles keep their full RAM requirement, so 16 GB Macs get `balanced` (2B),
  24 GB `desktop` (4B) and 32 GB or more `quality` (9B).
- Available memory is read from `vm_stat` (free, inactive and speculative
  pages). `os.freemem()` counts only free pages on macOS and reads as pressure.
- Saved credentials use Electron `safeStorage`, which is backed by the macOS
  Keychain. No change was needed.
- The menu-bar icon uses the PNG artwork, because macOS Electron cannot decode
  `.ico`. The Dock icon is set from the same file.

## Native helpers

On Windows, computer control, screen capture, window observation and the other
system integrations are C# and PowerShell helpers. On macOS they are one Swift
program, `capri-macos-helper`, in `packages/macos-helpers/Sources`. It speaks the
same JSON and binary protocols as the Windows helpers, so the JavaScript side
only chooses which executable to start.

### Building

```sh
npm run setup:macos-helpers          # builds when missing or out of date
npm run setup:macos-helpers -- --force
```

`npm run setup:macos` runs the same build at the end; a failure there is reported
but does not stop the rest of setup. The build:

- finds `swiftc` with `xcrun`, compiles every `*.swift` file in one module
  (`-O`, Swift 5 mode, `arm64-apple-macos14.0` or `x86_64-apple-macos14.0`);
- signs the result ad hoc with the identifier `com.capri.macos-helper`;
- writes it to `.runtime/macos-helpers/<first 16 hex of the source hash>/capri-macos-helper`;
- writes `.runtime/macos-helpers/build.json` last (`sourceSha256`, `artifact`,
  `executableSha256`, `target`), then removes earlier builds.

`packages/runtime/src/host/macos-helper.mjs` resolves the helper for every
caller. It refuses a helper whose receipt does not match the Swift sources (when
the sources are present) or whose bytes do not match `executableSha256`, with a
message that names `npm run setup:macos-helpers`. Every helper starts with a
fixed environment (`HOME`, `PATH=/usr/bin:/bin:/usr/sbin:/sbin`, `TMPDIR` inside
`.runtime/tmp`, `LANG`), so no keys or tokens from Capri's environment reach it.

### Subcommands

| Command                                                                                | Replaces (Windows)               | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| -------------------------------------------------------------------------------------- | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| _(none)_ or `desktop-actions`                                                          | `DesktopActions.cs`              | One JSON request on stdin, one JSON line out. `computer_state`, `computer_pointer`, `computer_click`, `computer_drag`, `computer_scroll`, `computer_keys`, `computer_type`, `computer_release`, `computer_window_exists` and `computer_watch_escape`, through Accessibility (AXUIElement) and CGEvent. `avatar_window` finds the window the avatar is dropped on or sent to (bounds and identity only). Other application actions answer `MACOS_ACTION_UNAVAILABLE`. |
| `screen-worker`                                                                        | `capture-display.ps1 -Worker`    | The binary frame pipe (`mode\|handle\|x\|y\|w\|h\|maxW\|maxH\|format` in, a 32-byte header and PNG or BGRA pixels out) through ScreenCaptureKit.                                                                                                                                                                                                                                                                                                                     |
| `screen-capture [--owned-window N \| --display-window N] [--with-geometry \| --probe]` | `capture-display.ps1`            | One PNG of the active display (base64), or its bounds.                                                                                                                                                                                                                                                                                                                                                                                                               |
| `window-events`                                                                        | `WindowsEvents.cs`               | App switches, full screen, lock and unlock, sleep and wake, idle after 5 minutes; with Accessibility, focused-window and tab changes. Titles and images are never reported.                                                                                                                                                                                                                                                                                          |
| `window-follow`                                                                        | `desktop-teleport.cs --watch`    | Follows the window the avatar sits on (`anchor <id> visible x y w h`, `hidden`, `closed`) and reports the mouse release of a drag that began on the avatar. Reads only window bounds and the button state.                                                                                                                                                                                                                                                           |
| `spotify`                                                                              | `SpotifyBridge.cs`               | Spotify desktop control through its AppleScript dictionary. Never launches Spotify.                                                                                                                                                                                                                                                                                                                                                                                  |
| `audio-endpoints list` / `capture <id>`                                                | `audio-endpoints.cs`             | Core Audio devices (`in:<UID>`, `out:<UID>`) and 16 kHz mono capture in the same `CAPRI-AUDIO-1` packet format. Outputs are captured through a Core Audio process tap (macOS 14.2 or later).                                                                                                                                                                                                                                                                         |
| `gpu`                                                                                  | GPU inventory and load           | Apple GPU name, core count and load from IOKit. Memory is reported as shared, without a VRAM figure.                                                                                                                                                                                                                                                                                                                                                                 |
| `tool-sandbox`                                                                         | `tool-sandbox.cs` (AppContainer) | Runs an approved Node or Python user tool under a fixed Seatbelt profile (see below).                                                                                                                                                                                                                                                                                                                                                                                |
| `permissions [request accessibility \| request screen-recording]`                      | —                                | Reads the privacy permissions; `request` shows the macOS prompt.                                                                                                                                                                                                                                                                                                                                                                                                     |
| `version`                                                                              | —                                | `{"ok":true,"helper":"capri-macos","version":1}`.                                                                                                                                                                                                                                                                                                                                                                                                                    |

Dragging the avatar onto another app's window works as on Windows: she snaps to
the nearest window edge within the snap radius, sits on it, follows it while it
moves, and jumps back to the desktop when it is minimized, closed, moved to
another Space or made full screen. Without Screen Recording, macOS hides other
apps' window titles, so "sit on the <name> window" matches the app name.

Coordinates are global points with the origin at the top left of the main
display, which is also what Electron uses on macOS, so the Windows DIP/pixel
conversions are identity functions there (`apps/desktop/main/screen-points.mjs`).
Key names keep the Windows vocabulary: `CTRL` presses Command, `ALT` Option and
`WIN` Control.

### Privacy permissions

macOS grants these to the _responsible app_: `Capri.app` once it is packaged, and
the app that started `npm run desktop` (Terminal, iTerm, an IDE) when running
from source. The prompt and the list in System Settings → Privacy & Security
name that app. Capri never changes these settings itself.

| Permission             | Needed for                                                      | When macOS asks                                                                                          |
| ---------------------- | --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Accessibility          | Computer control, the Escape stop, window title and tab changes | Capri asks on the first computer-control request; it stops with "No input was sent" until it is allowed. |
| Screen Recording       | Computer-control screenshots, screen frames, screen awareness   | Capri asks once per run when computer control starts. Capture fails cleanly until it is allowed.         |
| Automation → Spotify   | Spotify control                                                 | On the first Spotify command. A refusal is reported as `automation_denied`.                              |
| Microphone             | Microphone capture                                              | On first capture.                                                                                        |
| System audio recording | Capturing an output device                                      | On first capture. Needs `NSAudioCaptureUsageDescription` in the app's Info.plist.                        |

### Tool sandbox

Approved user tools run as `/usr/bin/sandbox-exec -p <profile> <runtime>` with
`(deny default)` plus `system.sb`. A tool can read its own code folder and the
Node or Python runtime, read and write only its private output folder (also its
`HOME` and `TMPDIR`), start no other program, and use the network only when its
manifest allows it. The helper enforces a 256 MiB footprint, the manifest timeout
and 64 KiB of output, and refuses linked or relative folders. Python tools use
`.runtime/python/cpython-3.11.*-macos-aarch64-none/bin/python3`. Executable
(`.exe`-style) tools are Windows-only.

### Tests

```sh
node --test tests/macos-helpers.test.mjs          # JavaScript side, runs on every OS
node --test tests/macos-helpers-native.test.mjs   # builds and runs the real helper (macOS only)
```

The native test sends no input, does not script Spotify and records no audio. It
reads the screen only when Screen Recording is already allowed, and checks the
Accessibility refusal (or a real observation, when allowed) without asking for it.

## Measured on an M4 Pro, 24 GB, macOS 26.7

- `npm run setup:macos`: Metal device `MTL0: Apple M4 Pro` (about 18 GiB usable).
- Profile chosen: `desktop` (`qwen3.5:4b`, 32K context).
- Cold `npm run desktop`: model server at about 1 s, chat model loaded at about
  11 s, core ready at about 21 s.
- `npm run chat`: first reply about 13 s, almost all of it reading the
  roughly 8K-token system prompt once. Later replies under 1 s.

## Checks on pull requests

`.github/workflows/macos.yml` runs on a GitHub-hosted Apple silicon runner for
every pull request (free for public repositories, about 9 minutes):

- `npm run check -- --require-python`, `npm run format:check` and
  `npm run release:check`.
- The unit suite through `node tools/checks/test-known-failures.mjs`. It fails on
  any failure not listed for macOS in `tools/checks/known-failures.json`. The
  listed tests cover Windows-only features (the installer, the updater, coding
  mode's `.exe` editors and tasks, computer control); they still run, and must
  pass, in the Windows job. The job summary lists both, and a listed test that
  starts passing produces a warning so it can be removed.
- `npm run setup:macos`, then `node tools/verify/verify-macos-smoke.mjs`:
  `capri doctor` sees the runtimes and unified memory, and the bundled
  llama-server answers a chat request with a 1 MB test model on the CPU and on
  Metal.
- The desktop (Electron) verifications that pass on macOS: companion settings,
  button feedback, languages, window dimming, app catalog settings, Spotify
  settings and the inference API.

Run the same unit check locally with `node tools/checks/test-known-failures.mjs`.

These desktop verifications fail on macOS today and are not part of the job yet:
`verify-desktop.mjs` (portrait crop focus differs), `verify-settings-first-open.mjs`
(the capture hook is not called), `verify-text-selection.mjs` (no selection
range) and `verify-maintenance-offline.mjs`. `verify-settings-lifecycle.mjs`,
`verify-update-handoff.mjs` and `verify-computer-control.mjs` are Windows-only.

## What is not done yet

These were left for separate pieces of work:

- **Voice and speech recognition.** The Python workers are pinned to CUDA/ROCm
  PyTorch and Windows `uv`. They need macOS `uv`, MPS or CPU PyTorch for
  Chatterbox and Qwen3-TTS, and macOS lockfiles. The ONNX models (Parakeet, Silero
  VAD, the request router, YAMNet) are platform-neutral. Use the router's
  `onnx/model_qint8_arm64.onnx` in place of the AVX2 file. Breeze TTS publishes
  only a Windows binary.
- **Native features without a Swift version yet.** Task recording, YouTube Music
  tab control, camera calls, the per-process and local-model load meters,
  Windows media-session playback, Steam game launch, the desktop teleport menu
  and virtual-audio-cable routing stay Windows-only. They are hidden or answer
  "not available" on macOS. Spotify search, liked songs, the queue and library
  browsing are not in Spotify's AppleScript dictionary; on macOS they answer
  `unsupported`, while playback, volume, seek, shuffle, repeat and Spotify links
  work. Other application actions of the desktop bridge (opening apps, files,
  drives) answer `MACOS_ACTION_UNAVAILABLE`.
- **Voice routing and music detection.** The audio helper lists and captures
  devices on macOS, but call audio routing and music detection stay off until the
  voice workers run on macOS.
- **Installer and app identity.** Running from source shows the app as
  "Electron" (`com.github.Electron`) in the app switcher. A packaged `Capri.app`
  needs its own bundle ID and name, an `.icns` icon, the Node and llama.cpp
  runtimes inside the bundle, data outside it (for example
  `~/Library/Application Support/Capri`), and ad-hoc signing for personal use or
  a Developer ID plus notarization for distribution. The Windows updater
  (`packages/updater`) does not apply. For the Swift helper, the bundle needs
  `NSAppleEventsUsageDescription` (Spotify), `NSAudioCaptureUsageDescription`
  (system audio) and `NSMicrophoneUsageDescription` in its Info.plist, and must
  ship `.runtime/macos-helpers/build.json` with the helper. Without the Swift
  sources, a packaged helper is checked only against its own digest, so re-signing
  it (for example with a Developer ID) means writing `executableSha256` again
  after signing.
- **Resource meter.** RAM reads from `vm_stat` and GPU load from IOKit through
  the helper. GPU memory and temperatures show as unknown on macOS: the GPU shares
  system memory, and temperatures would need `powermetrics` (root).
- **Not available on macOS:** the OpenVINO NPU option and CUDA voice training.
- **Observed, not investigated:** replies sent with `npm run chat` did not appear
  in the open desktop window's transcript. The window may show only its own
  session or refresh later.
