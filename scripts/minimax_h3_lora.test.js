import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveTestPython } from '../server/lib/testHelper.js';

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, 'minimax_h3_lora.py');
const loraProbe = join(here, 'minimax_h3_lora_probe.py');
const runtimeDir = join(homedir(), '.portos', 'minimax-h3-mlx');
const hasPinnedRuntime = existsSync(join(runtimeDir, 'minimax_h3_mlx', 'pipeline.py'));
const candidates = [
  join(homedir(), '.portos', 'minimax-h3-mlx', '.venv', 'bin', 'python3'),
  resolveTestPython(),
].filter((candidate, index, all) => candidate && all.indexOf(candidate) === index && existsSync(candidate));
const pyBin = candidates.find((candidate) => {
  try {
    execFileSync(candidate, ['-c', 'import mlx.core'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}) || null;

const runPython = (lines) => execFileSync(pyBin, ['-c', [
  'import sys',
  'from pathlib import Path',
  'sys.path.insert(0, str(Path(sys.argv[1]).parent))',
  ...lines,
].join('\n'), script], { encoding: 'utf8' });

describe.skipIf(!pyBin)('minimax_h3_lora.py', () => {
  it.skipIf(!hasPinnedRuntime)('capability-probes the installed quantized H3 runtime', () => {
    expect(execFileSync(pyBin, [loraProbe, runtimeDir], { encoding: 'utf8' })).toBe('');
  });

  it('adds an activation-space delta after a packed uint32 projection', () => {
    const output = runPython([
      'import mlx.core as mx, mlx.nn as nn, tempfile',
      'from minimax_h3_lora import LoRALinear, apply_loras',
      'class Attention(nn.Module):',
      '    def __init__(self):',
      '        super().__init__(); self.heads = 2; self.head_dim = 4; self.qkv_proj = nn.Linear(32, 24, bias=False)',
      'class Block(nn.Module):',
      '    def __init__(self):',
      '        super().__init__(); self.attn = Attention()',
      'class DiT(nn.Module):',
      '    def __init__(self):',
      '        super().__init__(); self.blocks = [Block()]',
      'model = DiT()',
      'nn.quantize(model, group_size=32, bits=8, class_predicate=lambda path, module: path.endswith("qkv_proj"))',
      'x = mx.arange(32, dtype=mx.float32).reshape(1, 1, 32) / 32',
      'before = model.blocks[0].attn.qkv_proj(x); mx.eval(before)',
      'with tempfile.TemporaryDirectory() as temp:',
      '    path = Path(temp) / "adapter_native.safetensors"',
      '    down = mx.arange(32, dtype=mx.float32).reshape(1, 32) / 32',
      '    up = mx.arange(24, dtype=mx.float32).reshape(24, 1) / 24',
      '    mx.save_safetensors(str(path), {"blocks.0.attn.qkv_proj.lora_a.weight": down, "blocks.0.attn.qkv_proj.lora_b.weight": up, "blocks.0.attn.qkv_proj.alpha": mx.array([1.0])})',
      '    apply_loras(model, [{"path": str(path), "scale": 0.5}])',
      '    after = model.blocks[0].attn.qkv_proj(x)',
      '    expected = before + ((x @ down.T) @ up.T) * 0.5',
      '    mx.eval(after, expected)',
      '    error = float(mx.max(mx.abs(after - expected)))',
      '    if error >= 1e-5: raise AssertionError(f"delta mismatch: {error}")',
      '    if not isinstance(model.blocks[0].attn.qkv_proj, LoRALinear): raise AssertionError("projection was not wrapped")',
      'print("ok")',
    ]);
    expect(output.trim()).toBe('ok');
  });

  it('normalizes H3 prefixes and converts reference-layout QKV rows', () => {
    const output = runPython([
      'import mlx.core as mx, mlx.nn as nn, tempfile',
      'from minimax_h3_lora import apply_loras',
      'class Attention(nn.Module):',
      '    def __init__(self):',
      '        super().__init__(); self.heads = 2; self.head_dim = 4; self.qkv_proj = nn.Linear(32, 24, bias=False)',
      'class Block(nn.Module):',
      '    def __init__(self):',
      '        super().__init__(); self.attn = Attention()',
      'class DiT(nn.Module):',
      '    def __init__(self):',
      '        super().__init__(); self.blocks = [Block()]',
      'model = DiT()',
      'with tempfile.TemporaryDirectory() as temp:',
      '    path = Path(temp) / "wushu_spatial_physics_pruned.safetensors"',
      '    down = mx.zeros((1, 32))',
      '    up = mx.arange(24, dtype=mx.float32).reshape(24, 1)',
      '    mx.save_safetensors(str(path), {"model.diffusion_model.transformer_blocks.0.attention.to_qkv.lora_A.weight": down, "model.diffusion_model.transformer_blocks.0.attention.to_qkv.lora_B.weight": up})',
      '    apply_loras(model, [{"path": str(path), "scale": 1.0}])',
      '    attached = model.blocks[0].attn.qkv_proj.adapters[0].up',
      '    expected = up.reshape(3, 2, 4, 1).transpose(1, 0, 2, 3).reshape(24, 1)',
      '    mx.eval(attached, expected)',
      '    if not bool(mx.all(attached == expected)): raise AssertionError("QKV rows were not converted")',
      'print("ok")',
    ]);
    expect(output.trim()).toBe('ok');
  });

  it('maps Diffusers split-QKV and gated-MLP exports onto the MLX tree', () => {
    const output = runPython([
      'import mlx.core as mx, mlx.nn as nn, tempfile',
      'from minimax_h3_lora import apply_loras',
      'class Attention(nn.Module):',
      '    def __init__(self):',
      '        super().__init__(); self.heads = 2; self.head_dim = 4; self.qkv_proj = nn.Linear(32, 24, bias=False)',
      'class Mlp(nn.Module):',
      '    def __init__(self):',
      '        super().__init__(); self.fc1 = nn.Linear(32, 16, bias=False)',
      'class Block(nn.Module):',
      '    def __init__(self):',
      '        super().__init__(); self.attn = Attention(); self.mlp = Mlp()',
      'class DiT(nn.Module):',
      '    def __init__(self):',
      '        super().__init__(); self.blocks = [Block()]',
      'model = DiT()',
      'with tempfile.TemporaryDirectory() as temp:',
      '    path = Path(temp) / "lightx2v-turbo.safetensors"',
      '    down = mx.zeros((1, 32))',
      '    q = mx.arange(8, dtype=mx.float32).reshape(8, 1)',
      '    k = mx.ones((8, 1))',
      '    v = mx.ones((8, 1)) * 2',
      '    mlp_up = mx.arange(16, dtype=mx.float32).reshape(16, 1)',
      '    mx.save_safetensors(str(path), {',
      '        "transformer_blocks.0.attn.to_q.lora_A.default.weight": down,',
      '        "transformer_blocks.0.attn.to_q.lora_B.default.weight": q,',
      '        "transformer_blocks.0.attn.to_q.alpha": mx.array([2.0]),',
      '        "transformer_blocks.0.attn.to_k.lora_A.default.weight": down,',
      '        "transformer_blocks.0.attn.to_k.lora_B.default.weight": k,',
      '        "transformer_blocks.0.attn.to_v.lora_A.default.weight": down,',
      '        "transformer_blocks.0.attn.to_v.lora_B.default.weight": v,',
      '        "transformer_blocks.0.ff.net.0.proj.lora_A.default.weight": down,',
      '        "transformer_blocks.0.ff.net.0.proj.lora_B.default.weight": mlp_up,',
      '    })',
      '    apply_loras(model, [{"path": str(path), "scale": 1.0}])',
      '    qkv = model.blocks[0].attn.qkv_proj.adapters',
      '    expected_q = mx.stack([q.reshape(2, 4, 1), mx.zeros((2, 4, 1)), mx.zeros((2, 4, 1))], axis=2).transpose(0, 2, 1, 3).reshape(24, 1)',
      '    expected_fc1 = mx.concatenate([mlp_up[8:], mlp_up[:8]], axis=0)',
      '    mx.eval(*(adapter.up for adapter in qkv), expected_q, expected_fc1)',
      '    if len(qkv) != 3: raise AssertionError(f"expected 3 QKV adapters, got {len(qkv)}")',
      '    if not any(bool(mx.all(adapter.up == expected_q)) and adapter.scale == 2.0 for adapter in qkv): raise AssertionError("Q adapter was not expanded or alpha-scaled")',
      '    if not any(adapter.scale == 8.0 for adapter in qkv): raise AssertionError("Diffusers default alpha was not applied")',
      '    if not any(bool(mx.all(adapter.up == expected_fc1)) and adapter.scale == 8.0 for adapter in model.blocks[0].mlp.fc1.adapters): raise AssertionError("fc1 gate/value order or alpha was not applied")',
      'print("ok")',
    ]);
    expect(output.trim()).toBe('ok');
  });
});
