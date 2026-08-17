#!/usr/bin/env python3
"""MiniMax Music 3 Diffusers sidecar using PortOS' STAGE/RESULT protocol."""
import argparse
import inspect
import json
import os
import sys
import wave


def to_numpy(audio, np, torch):
    """Diffusers hands back either a torch tensor or an ndarray depending on version."""
    while isinstance(audio, (list, tuple)):
        audio = audio[0]
    if isinstance(audio, torch.Tensor):
        return audio.detach().float().cpu().numpy()
    return np.asarray(audio)


def to_stereo(audio, np):
    """Orient a decoded waveform to (2, samples) float32 whichever layout it arrives in."""
    audio = np.squeeze(audio).astype(np.float32)
    if audio.ndim == 1:
        return np.stack([audio, audio])
    if audio.ndim != 2:
        raise RuntimeError(f'unexpected audio shape {audio.shape}')
    if audio.shape[0] == 2:
        return audio
    # Channels-last (samples, 2), or a lone channel row - orient to (2, samples).
    return audio.T if audio.shape[1] == 2 else np.stack([audio[0], audio[0]])


def seeded_generation_kwargs(pipe, torch, seed):
    """Return a CUDA generator only when this Diffusers pipeline accepts one."""
    if seed is None:
        return {}
    try:
        parameters = inspect.signature(pipe.__call__).parameters
    except (TypeError, ValueError):
        return {}
    accepts_generator = 'generator' in parameters or any(
        parameter.kind == inspect.Parameter.VAR_KEYWORD for parameter in parameters.values()
    )
    if not accepts_generator:
        return {}
    return {'generator': torch.Generator(device='cuda').manual_seed(int(seed))}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--model', required=True)
    parser.add_argument('--text', required=True)
    parser.add_argument('--lyrics', default='')
    parser.add_argument('--duration', type=float, required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--runtime-dir', default='')
    # This is intentionally a sidecar-only benchmark hook. The production
    # server does not pass it, so normal user renders retain the model's
    # default sampling behavior.
    parser.add_argument('--seed', type=int, default=None)
    args = parser.parse_args()
    if args.runtime_dir:
        sys.path.insert(0, args.runtime_dir)

    import numpy as np
    import torch
    from diffusers import ModularPipeline

    if not torch.cuda.is_available():
        raise RuntimeError('MiniMax Music 3 requires CUDA')
    print('STAGE:load-model', file=sys.stderr, flush=True)
    pipe = ModularPipeline.from_pretrained(args.model)
    pipe.load_components(dtype=torch.bfloat16)
    pipe.to('cuda')
    print('STAGE:generate', file=sys.stderr, flush=True)
    generation_kwargs = seeded_generation_kwargs(pipe, torch, args.seed)
    if args.seed is not None and not generation_kwargs:
        raise RuntimeError('this Diffusers pipeline does not support deterministic --seed generation')
    audio = to_numpy(pipe(
        prompt=args.text,
        lyrics=args.lyrics,
        audio_duration=float(max(1, min(300, args.duration))),
        output='audios',
        **generation_kwargs,
    )[0], np, torch)
    audio = to_stereo(audio, np)
    source_rate = int(pipe.sampling_rate)
    if source_rate != 32000:
        source_x = np.arange(audio.shape[1], dtype=np.float64)
        target_x = np.linspace(0, audio.shape[1] - 1, round(audio.shape[1] * 32000 / source_rate))
        audio = np.stack([np.interp(target_x, source_x, channel) for channel in audio])
    pcm = np.clip(audio, -1, 1)
    pcm = (pcm.T * 32767).astype(np.int16)
    os.makedirs(os.path.dirname(args.output), exist_ok=True)
    with wave.open(args.output, 'wb') as wav:
        wav.setnchannels(2); wav.setsampwidth(2); wav.setframerate(32000); wav.writeframes(pcm.tobytes())
    print('RESULT:' + json.dumps({
        'durationSec': len(pcm) / 32000,
        **({'seed': args.seed, 'seedApplied': True} if args.seed is not None else {}),
    }), flush=True)


if __name__ == '__main__':
    main()
