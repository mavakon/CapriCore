# macOS (Apple silicon)

Capri runs on macOS with Apple silicon (arm64): text chat, memory and the
animated avatar, with local models on the Metal GPU or an OpenAI-compatible API.
It installs as `Capri.app` from a disk image, or runs from source. Voice, and
screen and computer control, are separate follow-up work (see
[What is not done yet](#what-is-not-done-yet)).

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
(Capri refuses runtime paths that pass through symbolic links).

```sh
npm ci
npm run setup:macos   # pinned llama.cpp Metal build + Electron app bundle, into .runtime/
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

## Measured on an M4 Pro, 24 GB, macOS 26.7

- `npm run setup:macos`: Metal device `MTL0: Apple M4 Pro` (about 18 GiB usable).
- Profile chosen: `desktop` (`qwen3.5:4b`, 32K context).
- Cold `npm run desktop`: model server at about 1 s, chat model loaded at about
  11 s, core ready at about 21 s.
- `npm run chat`: first reply about 13 s, almost all of it reading the
  roughly 8K-token system prompt once. Later replies under 1 s.

## What is not done yet

These were left for separate pieces of work:

- **Voice and speech recognition.** The Python workers are pinned to CUDA/ROCm
  PyTorch and Windows `uv`. They need macOS `uv`, MPS or CPU PyTorch for
  Chatterbox and Qwen3-TTS, and macOS lockfiles. The ONNX models (Parakeet, Silero
  VAD, the request router, YAMNet) are platform-neutral. Use the router's
  `onnx/model_qint8_arm64.onnx` in place of the AVX2 file. Breeze TTS publishes
  only a Windows binary.
- **Native helpers.** Everything under `apps/desktop/native`,
  `integrations/*/native` and `packages/installer/windows` is C# or PowerShell.
  This covers computer control, screen capture, window observation, the Escape
  stop, task recording, the tool sandbox, Spotify accessibility, system-audio and
  music capture, and the GPU monitor. These features stay off on macOS
  (`process.platform === 'win32'` guards) until Swift replacements exist. Their
  macOS equivalents are ScreenCaptureKit, Accessibility (AXUIElement), CGEvent
  and Core Audio taps.
- **Distribution signing.** `Capri.app` is signed ad hoc. Sharing it beyond
  your own Macs without the Gatekeeper warning needs an Apple Developer ID
  signature with the hardened runtime and notarization. Running from source still
  shows "Electron" in the app switcher.
- **Setup window language.** The first-run setup window is in English; the app
  itself uses the interface language chosen there.
- **Resource meter.** RAM reads from `vm_stat`. GPU load, unified-memory use and
  temperatures show as unknown on macOS (they come from Windows and NVIDIA
  samplers); `powermetrics` or IOKit would be the macOS sources.
- **Not available on macOS:** the OpenVINO NPU option and CUDA voice training.
- **Observed, not investigated:** replies sent with `npm run chat` did not appear
  in the open desktop window's transcript. The window may show only its own
  session or refresh later.
