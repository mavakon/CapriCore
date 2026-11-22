# macOS (Apple silicon)

Capri runs on macOS with Apple silicon (arm64): text chat, memory and the
animated avatar, with local models on the Metal GPU or an OpenAI-compatible API,
plus speech recognition and voice (see
[Voice and speech recognition](#voice-and-speech-recognition)). From source it
also has computer control, screen capture, window awareness, Spotify playback
control, the user-tool sandbox and the GPU meter, through a Swift helper (see
[Native helpers](#native-helpers)). It installs as `Capri.app` from a disk image,
or runs from source. The Swift helper inside `Capri.app` is separate follow-up
work (see [What is not done yet](#what-is-not-done-yet)).

## Install the app

1. Open `Capri-<version>-macos-arm64.dmg` and drag **Capri** onto
   **Applications**. (If you open Capri straight from the disk image, it offers
   to move itself to Applications first.)
2. Open Capri from Applications. The app is signed ad hoc, not with an Apple
   Developer ID. A copy you built on this Mac opens normally. A downloaded copy is
   blocked the first time: open **System Settings → Privacy & Security** and
   choose **Open Anyway** for Capri.
3. First-run setup copies Capri into its data folder (about a minute), then asks
   for the license, the language model, and the languages, and downloads the
   models: about 4.5 GB for the 4B model on a 24 GB Mac, of which 1.2 GB is the
   memory model every setup needs. Capri then restarts and opens.

Requirements: macOS 13 (Ventura) or later on Apple silicon, and free disk space for the
models (setup shows the amount).

### Where Capri keeps things

| What                                                                                    | Where                                      |
| --------------------------------------------------------------------------------------- | ------------------------------------------ |
| The app (code and runtimes, read-only)                                                  | `/Applications/Capri.app`                  |
| Capri's installation: a copy of the app's code, settings, conversations, memory, models | `~/Library/Application Support/Capri`      |
| Capri's own logs                                                                        | `~/Library/Application Support/Capri/logs` |
| App launcher and setup log                                                              | `~/Library/Logs/Capri/launcher.log`        |
| Setup window cache                                                                      | `~/Library/Caches/com.capri-core.desktop`  |

Capri keeps its settings and data next to its code, and its tools change files
there, so the app runs a copy of its code from Application Support rather than
from the signed bundle. On APFS that copy is a clone and takes almost no extra
space. Local services use ports 100 above the defaults (gateway 18889, model
server 11535, voice 8201), so the app can run next to a source checkout.

The `capri` command line works on the installed copy, for example
`~/Library/Application\ Support/Capri/.runtime/node-v24.22.1-darwin-arm64/bin/node
~/Library/Application\ Support/Capri/packages/runtime/bin/capri.mjs doctor`.
`capri.mjs desktop` there opens the app.

### Updates

Capri checks the macOS port's GitHub releases (`mavakon/CapriCore`) for a
newer `Capri-<version>-macos-arm64.dmg`, never the Windows installer. **Restart
and update** downloads the image, checks the SHA-256 that GitHub publishes for
it, checks the new app's identity, version and signature, copies it next to the
running app and swaps the two after Capri quits. If Capri cannot write to the
app's folder (for example `/Applications` for a standard account), it opens the
image in Finder instead. On its first launch the new version updates the copy in
Application Support from its own payload. Conversations, memory, models,
`*.local.json` settings and the files listed in `PRESERVED_FILES`
(`apps/macos-launcher/install-root.mjs`) are kept; a shipped file you edited
that the new version no longer has is moved to
`.runtime/macos/replaced/<time>/`.

An ad-hoc signature changes with every build, so macOS asks again for the
microphone and other permissions after an update, and may ask to allow Keychain
access to Capri's saved credentials once.

### Uninstall

Quit Capri (menu bar icon → Quit), then move `/Applications/Capri.app`,
`~/Library/Application Support/Capri` (this deletes conversations, memory and
models), `~/Library/Logs/Capri` and `~/Library/Caches/com.capri-core.desktop` to
the Trash.

### Troubleshooting

- Setup or start failures are in `~/Library/Logs/Capri/launcher.log` (one JSON
  line per event, no conversation text). Setup's **Show Logs** opens the folder.
- "contains files that Capri did not create": something else already uses
  `~/Library/Application Support/Capri`. Rename it, then open Capri again.
- "newer than this app": the data was last used by a newer Capri. Install that
  version or a later one.

## Build the app

On a Mac with Apple silicon and Node.js 24.22.1 (see below), from a clean
checkout:

```sh
npm ci
npm run release:macos
```

`tools/release/build-macos-app.mjs` downloads the Electron, Node.js and llama.cpp
builds pinned in `config/macos-runtime.json` (each checked by SHA-256, cached in
`.downloads/macos`), and writes `release/macos/Capri-<version>-macos-arm64.dmg`
with a `.sha256` file and `release/macos/work/Capri.app`. The version comes from
`config/release.json`. It takes about ten minutes and needs about 6 GB of free
space. To publish an update, attach the `.dmg` to a GitHub release of
`mavakon/CapriCore` whose tag is that version; GitHub records its SHA-256.

How the app is put together:

- `Capri.app` is the pinned Electron for macOS, renamed (`Capri`, `Capri Helper
(GPU)`, …), with bundle identifier `com.capri-core.desktop`, the icon from
  `assets/default/macos/AppIcon-1024.png` (drawn by
  `tools/assets/build-macos-icon.py`), usage descriptions for the microphone,
  camera, system audio, Apple Events and the local network, and an ad-hoc
  signature over the whole bundle.
- `Contents/Resources/app` is the launcher (`apps/macos-launcher`).
  `Contents/Resources/capri` is the payload: the release source files (the same
  set and privacy checks as `npm run release:source`), production npm
  dependencies installed with the bundled Node.js, the Node.js binary, and
  llama.cpp. `capri-payload.json` lists every file with its size, SHA-256 and
  mode; `capri-build.json` summarises it with a fingerprint.
- On each launch the launcher compares that fingerprint with the installed
  copy's receipt (`.runtime/macos/installed.json`). If they match and setup is
  complete, the launcher process becomes the desktop: it imports the installed
  `apps/desktop/main.mjs` before Electron is ready, with the same environment
  `capri.mjs desktop` gives it. Otherwise it opens the setup window, copies the
  payload (verifying every file's hash), and runs first-run setup
  (`packages/installer/src/macos-setup.mjs`): the Windows installer's
  validation and model selection, then `capri.mjs setup`, `models` and
  `doctor`. Running the desktop in the app's own process gives Capri one Dock
  icon, its name and identifier in the app switcher, and privacy prompts that
  name Capri. The trade-off is that a desktop crash closes the app (macOS shows
  its own crash report) instead of a Capri crash dialog.

### Adding native helpers and optional components

- Native macOS helpers (for example Swift screen capture or computer control):
  add an entry to `MACOS_HELPERS` in `tools/release/macos-helpers.mjs`. The build
  compiles it into the payload; the app installs it with everything else.
  Processes Capri.app starts are attributed to Capri for Screen Recording,
  Accessibility and Microphone permission.
- Optional first-run downloads (for example speech recognition or a voice):
  add an entry to `MACOS_SETUP_COMPONENTS` in
  `packages/installer/src/macos-setup.mjs`. The setup window lists it and
  installs it after the models.

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

## Voice and speech recognition

Speech needs macOS 14 or later on Apple silicon. Install it from Settings →
Languages (Install and enable), or from a checkout:

```sh
npm run setup:macos-speech -- --speech en --recognition en
npm run setup:macos-speech -- --speech fr --recognition auto-europe
npm run setup:macos-speech -- --speech off --recognition de   # recognition only
```

- The Windows PowerShell setup scripts have Node counterparts
  (`packages/installer/src/macos-python.mjs`, `macos-speech.mjs`) that use the
  same locks, provisioning scripts and model pins. They install the pinned `uv`
  (SHA-256 checked) and uv's managed CPython 3.11.17 into `.runtime`, and create
  the same owned virtual environments. macOS venvs use `bin/python`, a link to
  the managed interpreter; `packages/runtime/src/host/python-env.mjs` resolves
  the layout, and only a link into `.runtime/python` is accepted.
- Recognition (Parakeet and Silero VAD on ONNX Runtime, Whisper for other
  languages) uses `config/asr-requirements.lock.txt` unchanged.
- With the voice set to Automatic in Model devices, each engine runs where it
  measured faster (see [Speech on the M4 Pro](#speech-on-the-m4-pro)):
  English Chatterbox Turbo and Qwen3-TTS on the CPU, Chatterbox Multilingual on
  the Apple GPU through PyTorch's Metal backend (MPS). Running Turbo and Qwen on
  the CPU also leaves the GPU to the chat model. The rule is
  `engine_config` in `integrations/voice_runtime/accelerator.py`; choosing CPU
  runs every engine on the CPU, and `CAPRI_VOICE_COMPUTE_DEVICE=mps` (for
  benchmarks) runs every engine on Metal. Metal is used only when a small Metal
  check passes, else the CPU. `PYTORCH_ENABLE_MPS_FALLBACK=1` runs the few
  operators Metal lacks on the CPU; none were needed in the benchmark. Apple
  silicon shares one memory pool, so the CUDA rules for moving the decoder off a
  full GPU, CUDA Graph and `nvidia-smi` do not apply. The voice's
  dependencies come from `config/requirements-voice-macos.lock`, generated from
  `config/requirements-voice-macos.in` on a Mac (the command is in the lock's
  header). It keeps the Windows lock's versions; Chatterbox and Perth are the
  same commits, installed from hash-locked GitHub archives because a Mac has no
  bundled Git. `config/voice-macos-overrides.txt` pins Perth while compiling,
  because Chatterbox itself asks for Perth's moving `master` branch. uv records
  such an archive install without its hash, so the voice doctor identifies the
  source by the official archive URL of the pinned commit; the lock's
  `--require-hashes` sync has already checked the archive.
  `tests/macos_locks_test.py` checks both macOS locks against the Windows pins.
- Qwen3-TTS uses `config/requirements-qwen-tts-macos.lock`, which keeps the
  Windows lock's versions with PyPI's PyTorch build, and runs in FP32. On Metal
  (only when chosen explicitly) it needs 3 GiB of GPU budget, 6 GiB for the
  Russian voice; BF16 stays the CUDA/ROCm path. The NVIDIA and AMD acceleration
  installers are hidden on a Mac.
- Voice packs are extracted by `packages/installer/src/zip-archive.mjs`, which
  applies the Windows extractor's rules (no traversal, links, duplicates or
  oversized expansion, and a CRC check on every file).
- The desktop asks macOS for microphone access before it starts capture. A
  denial points to System Settings → Privacy & Security → Microphone. A packaged
  app must declare `NSMicrophoneUsageDescription` in its `Info.plist`.
- Not available on macOS: Breeze TTS (Windows x64 binary only), the OpenVINO NPU
  option and voice training (CUDA). The settings explain this instead of
  offering them.

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

### Speech on the M4 Pro

Each voice ran in its own server process with 8 CPU threads, one untimed
warm-up, then five sentences of 16 to 21 words. RTF is synthesis time divided
by the audio's length, so below 1 is faster than real time. GeForce NOW and OBS
were also using the GPU, which a Mac in normal use may do too.

| Voice   | Engine                                           | Apple GPU (MPS) | CPU   | Automatic |
| ------- | ------------------------------------------------ | --------------- | ----- | --------- |
| English | Chatterbox Turbo, FP32                           | 0.654           | 0.514 | CPU       |
| French  | Chatterbox Multilingual (FP16 backbone on Metal) | 1.438           | 2.382 | Apple GPU |
| Russian | Qwen3-TTS 0.6B, FP32                             | 3.493           | 1.484 | CPU       |

The values are median RTF; a second English run gave 0.628 (GPU) and 0.488
(CPU). The 1.7B Russian Capri voice (a LoRA on Qwen3-TTS) was not measured and
follows the same rule. Startup with the models on disk took 10 to 17 s, except
the first Metal start after creating the venv, which took 52 s. A fresh English
install from a warm uv cache took 11 s. The voice venv, the Qwen venv and uv's cache use about
1.0, 0.9 and 2.0 GiB. The disk check uses the sizes in `config/macos-runtime.json`
(`storage`), measured with PyPI's PyTorch for macOS: it asks for 7.0 GiB free for
English speech and recognition (3.8 GiB of downloads), 5.9 GiB for English speech
alone.

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

- **Request router on macOS.** The router venv still uses the Windows paths.
  Use the router's `onnx/model_qint8_arm64.onnx` in place of the AVX2 file.
- **Speech in first-run setup.** `Capri.app`'s first-run setup does not offer
  speech yet (`MACOS_SETUP_COMPONENTS` in `packages/installer/src/macos-setup.mjs`
  is empty); install it afterwards from Settings → Languages. Speech was tested
  from a source checkout, not yet inside the installed app.
- **The Swift helper in `Capri.app`.** The app build does not compile the
  helper yet (`MACOS_HELPERS` in `tools/release/macos-helpers.mjs` is empty). The
  installed app has no helper unless the Xcode command line tools build one there
  (turning on Spotify does), and without it computer control, screen capture,
  window awareness, Spotify and the GPU meter stay off. `npm run setup:macos`
  builds it for a source checkout. The entry should run `buildMacosHelper` on the payload, so that
  `.runtime/macos-helpers/build.json` ships with the helper. The helper must
  always match the receipt's `executableSha256`, so if signing the bundle
  re-signs the helper, that digest has to be written again afterwards. The
  helper needs macOS 14 or later, while the app opens on macOS 13; on macOS 13
  the helper's features would stay off.
- **Native features without a Swift version yet.** Task recording, YouTube Music
  tab control, camera calls, the per-process and local-model load meters,
  Windows media-session playback, Steam game launch, the desktop teleport menu
  and virtual-audio-cable routing stay Windows-only. They are hidden or answer
  "not available" on macOS. Spotify search, liked songs, the queue and library
  browsing are not in Spotify's AppleScript dictionary; on macOS they answer
  `unsupported`, while playback, volume, seek, shuffle, repeat and Spotify links
  work. Other application actions of the desktop bridge (opening apps, files,
  drives) answer `MACOS_ACTION_UNAVAILABLE`.
- **Call audio routing and music detection.** The audio helper lists and
  captures devices on macOS, but call audio routing and music detection are not
  wired up on macOS yet.
- **Distribution signing.** `Capri.app` is signed ad hoc. Sharing it beyond
  your own Macs without the Gatekeeper warning needs an Apple Developer ID
  signature with the hardened runtime and notarization. Running from source still
  shows "Electron" in the app switcher.
- **Setup window language.** The first-run setup window is in English; the app
  itself uses the interface language chosen there.
- **Resource meter.** RAM reads from `vm_stat` and GPU load from IOKit through
  the helper. GPU memory and temperatures show as unknown on macOS: the GPU shares
  system memory, and temperatures would need `powermetrics` (root).
- **Not available on macOS:** Breeze TTS (Windows x64 binary only), the OpenVINO
  NPU option and CUDA voice training.
- **Observed, not investigated:** replies sent with `npm run chat` did not appear
  in the open desktop window's transcript. The window may show only its own
  session or refresh later.
