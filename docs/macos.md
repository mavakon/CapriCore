# macOS (Apple silicon) — foundation

Capri's desktop runs from source on macOS with Apple silicon (arm64). This is the
first stage of the port: text chat, memory and the animated avatar, with local
models on the Metal GPU or an OpenAI-compatible API, plus speech recognition and
voice (see [Voice and speech recognition](#voice-and-speech-recognition)). Screen
and computer control, and a signed `.app`/`.dmg` installer are separate follow-up
work (see [What is not done yet](#what-is-not-done-yet)).

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
| Russian | Qwen3-TTS 1.7B Capri LoRA, FP32                  | 3.493           | 1.484 | CPU       |

The values are median RTF; a second English run gave 0.628 (GPU) and 0.488
(CPU). The 0.6B Qwen voice was not measured and follows the Russian voice. Startup with the models on disk took 10 to 17 s, except the first Metal
start after creating the venv, which took 52 s. A fresh English install from a
warm uv cache took 11 s. The voice venv, the Qwen venv and uv's cache use about
1.0, 0.9 and 2.0 GiB. The disk check uses the sizes in `config/macos-runtime.json`
(`storage`), measured with PyPI's PyTorch for macOS: it asks for 7.0 GiB free for
English speech and recognition (3.8 GiB of downloads), 5.9 GiB for English speech
alone.

## What is not done yet

These were left for separate pieces of work:

- **Request router on macOS.** The router venv still uses the Windows paths.
  Use the router's `onnx/model_qint8_arm64.onnx` in place of the AVX2 file.
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
- **Resource meter.** RAM reads from `vm_stat`. GPU load, unified-memory use and
  temperatures show as unknown on macOS (they come from Windows and NVIDIA
  samplers); `powermetrics` or IOKit would be the macOS sources.
- **Not available on macOS:** Breeze TTS, the OpenVINO NPU option and CUDA voice
  training.
- **Observed, not investigated:** replies sent with `npm run chat` did not appear
  in the open desktop window's transcript. The window may show only its own
  session or refresh later.
