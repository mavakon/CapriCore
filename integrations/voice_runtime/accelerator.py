"""Voice compute devices. Importing this module does not import torch.

Windows keeps NVIDIA CUDA or AMD ROCm through ``torch.cuda``. On macOS the
Apple GPU is used through PyTorch's Metal (MPS) backend, and every model can
fall back to the CPU. CUDA Graph, nvidia-smi and VRAM paging rules stay
CUDA-only; Apple silicon shares one memory pool between CPU and GPU.
"""
import sys

MPS = 'mps'
CUDA = 'cuda:0'


def macos(platform=None):
    return (platform or sys.platform) == 'darwin'


def apple_gpu(torch, platform=None):
    """True when this PyTorch build can run kernels on the Mac's Apple GPU."""
    if not macos(platform):
        return False
    backend = getattr(getattr(torch, 'backends', None), 'mps', None)
    try:
        return bool(backend is not None and backend.is_built() and backend.is_available())
    except (RuntimeError, AttributeError, OSError):
        return False


def is_mps(device):
    return str(device).split(':', 1)[0] == MPS


# Automatic speech on Apple silicon, measured on an M4 Pro (docs/macos.md):
# English Turbo and Qwen speak faster on the CPU, and Multilingual's FP16
# backbone on the Apple GPU. CPU speech also leaves the GPU to the local LLM.
APPLE_CPU_ENGINES = frozenset({'turbo', 'qwen3-tts', 'qwen3-tts-ru-lora'})


def engine_config(config, engine):
    """The voice settings one engine runs with; only Automatic on a Mac differs.

    An explicit Apple GPU choice (CAPRI_VOICE_COMPUTE_DEVICE=mps) still runs
    every engine on Metal, and an explicit CPU choice every engine on the CPU.
    """
    if (config.get('automaticDevice') and is_mps(config.get('computeDevice'))
            and engine in APPLE_CPU_ENGINES):
        return {**config, 'computeDevice': 'cpu', 'cpuReason': 'apple-cpu-faster'}
    return config


def is_cuda(device):
    return str(device).split(':', 1)[0] == 'cuda'


def gpu_device(torch, platform=None):
    """The GPU this platform uses, or None when only the CPU is usable."""
    if macos(platform):
        return MPS if apple_gpu(torch, platform) else None
    return CUDA


def synchronize(torch, device):
    if is_cuda(device):
        torch.cuda.synchronize()
    elif is_mps(device):
        torch.mps.synchronize()


def empty_cache(torch, platform=None):
    """Release inactive allocator blocks of the GPU backend this platform uses."""
    if macos(platform):
        if apple_gpu(torch, platform):
            torch.mps.empty_cache()
        return
    torch.cuda.empty_cache()


def memory_bytes(torch, platform=None):
    """(allocated, reserved) GPU bytes owned by this process, for health reports."""
    if macos(platform):
        if not apple_gpu(torch, platform):
            return 0, 0
        return int(torch.mps.current_allocated_memory()), int(torch.mps.driver_allocated_memory())
    return torch.cuda.memory_allocated(), torch.cuda.memory_reserved()


def out_of_memory(torch, error):
    """CUDA, ROCm and MPS allocation failures; never a generic runtime error."""
    kinds = tuple(kind for kind in (getattr(torch, 'OutOfMemoryError', None),
                                    getattr(getattr(torch, 'cuda', None), 'OutOfMemoryError', None))
                  if isinstance(kind, type))
    if kinds and isinstance(error, kinds):
        return True
    return isinstance(error, RuntimeError) and 'MPS backend out of memory' in str(error)


def mps_preflight(torch, platform=None):
    """Small real Metal check, matching cuda_preflight's report shape."""
    report = {'available': apple_gpu(torch, platform), 'kernelReady': False, 'backend': MPS,
              'torch': str(torch.__version__), 'runtime': 'metal'}
    if not report['available']:
        report['error'] = ('PyTorch cannot use the Apple GPU (Metal) on this Mac.'
                           if macos(platform) else 'The Apple GPU backend is only used on macOS.')
        return report
    try:
        report['device'] = 'Apple GPU (Metal)'
        value = torch.arange(16, device=MPS, dtype=torch.float32)
        if float(((value + 1) * 2).sum().item()) != 272.0:
            raise RuntimeError('MPS arithmetic validation failed')
        matrix = torch.eye(4, device=MPS, dtype=torch.float32)
        if float((matrix @ matrix).sum().item()) != 4.0:
            raise RuntimeError('MPS matrix validation failed')
        torch.mps.synchronize()
        try:
            report['recommendedMaxMemoryBytes'] = int(torch.mps.recommended_max_memory())
        except (AttributeError, RuntimeError):
            pass
        report['kernelReady'] = True
    except Exception as exc:
        report['error'] = f'{type(exc).__name__}: {exc}'
    return report
