# The first reply reuses the processed prompt

A desktop turn sends Capri's whole system prompt and tool schemas: on the Mac with Qwen3.5 4B that is about 7,700 to 8,100 tokens. llama.cpp evaluates them at roughly 600 to 700 tokens per second, so a cold prompt costs 11 to 13 seconds before the first word. A later reply reuses the prompt that the runner already holds and starts in about half a second.

Three things used to throw that processed prompt away:

- The runner unloads after its keep-alive (five idle minutes in the desktop profile), and every Capri start begins with a new runner.
- The Gateway warmup at startup sends its own, much smaller prompt (about 2,200 tokens with two tools), so it never matches a real desktop turn.
- Qwen3.5 is a hybrid model with recurrent layers. llama.cpp cannot resume it from an arbitrary shared prefix, only from a saved context checkpoint.

## What Capri does now

When the chat runner stops (the idle unload, a model or context change, or quitting Capri), the inference service asks llama-server to save its slot: the KV cache, the recurrent state and the context checkpoints. The next runner for the same model restores that file before it serves its first request, so the next reply continues from the saved conversation exactly as a later reply would. The Gateway warmup still runs, but llama-server keeps the restored state in its prompt cache and returns to it for the next desktop turn.

- The file is `data/run/llama-slots/chat-<fingerprint>.bin`. The fingerprint covers the engine build, the model files, the chat template and the context size, so a state is never loaded into a different model or layout. Only the newest file is kept, and it is deleted once it is restored.
- Nothing is saved while less than 2 GiB of disk is free. A missing, stale or unreadable file only costs the normal first evaluation.
- The chat runner keeps four context checkpoints instead of llama.cpp's default 32. Four keep the end of the system prompt and the latest turn, which is all Capri's turns need, and each Qwen3.5 4B checkpoint is about 50 MiB.

## Measurements

`tools/benchmarks/benchmark-first-reply.mjs` drives the real runner code against the installed model with a prompt the size of the desktop prompt (13,600 system characters and 13 tools). Apple M4 Pro, Qwen3.5 4B on Metal, 32,768-token context, 2026-11-22:

| Reply                                  | Before |  After |
| -------------------------------------- | -----: | -----: |
| First reply, nothing saved yet         | 12.1 s | 12.4 s |
| Later reply                            | 0.55 s | 0.57 s |
| First reply after the idle unload      | 12.3 s |  1.5 s |
| First reply after a restart and warmup | 11.7 s | 0.54 s |

After the idle unload the reply also includes loading the model again (about one second). The saved state was about 400 MB, saving took about 200 ms and restoring about 60 ms. After a restart llama-server's footprint was 148 MB higher than before, because its prompt cache holds both the warmup and the restored conversation. With llama.cpp's default 32 checkpoints the file grew from 451 to 769 MB within three turns and the footprint rose by 522 MB, at the same speed.

`tools/verify/verify-first-reply-cache.mjs` runs the same check through the real inference service (`packages/runtime/bin/llama-host.mjs`), including the idle unload and a stop and start of the service. The macOS smoke test checks that the pinned llama-server saves, restores and reuses a prompt.

The very first reply after installing, or after an update that changes the engine or model, still evaluates the whole prompt once.
