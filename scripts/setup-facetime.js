import { existsSync, mkdirSync } from 'fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'path';
import { homedir } from 'os';

if (process.platform !== 'darwin') {
  console.error('FaceTime Audio setup requires macOS.');
  process.exit(1);
}

const source = join(import.meta.dirname, '..', 'server', 'native', 'facetime-ax', 'main.swift');
const output = join(homedir(), '.portos', 'voice', 'facetime-ax');
if (!existsSync(source)) throw new Error('FaceTime helper source is missing');
mkdirSync(dirname(output), { recursive: true });
execFileSync('swiftc', ['-O', source, '-o', output], { stdio: 'inherit' });
console.log('✅ FaceTime Audio helper installed. Grant it Accessibility access before use.');
