# macOS (Apple silicon) — foundation

Capri's desktop runs from source on macOS with Apple silicon (arm64). This is the
first stage of the port: text chat, memory and the animated avatar, with local
models on the Metal GPU or an OpenAI-compatible API. Voice, screen and computer
control, and a signed `.app`/`.dmg` installer are separate follow-up work (see
[What is not done yet](#what-is-not-done-yet)).

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
- **Installer and app identity.** Running from source shows the app as
  "Electron" (`com.github.Electron`) in the app switcher. A packaged `Capri.app`
  needs its own bundle ID and name, an `.icns` icon, the Node and llama.cpp
  runtimes inside the bundle, data outside it (for example
  `~/Library/Application Support/Capri`), and ad-hoc signing for personal use or
  a Developer ID plus notarization for distribution. The Windows updater
  (`packages/updater`) does not apply.
- **Not available on macOS:** the OpenVINO NPU option and CUDA voice training.
- **Observed, not investigated:** replies sent with `npm run chat` did not appear
  in the open desktop window's transcript. The window may show only its own
  session or refresh later.
