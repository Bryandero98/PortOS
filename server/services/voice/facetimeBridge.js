// Machine-local FaceTime Audio control plane. The native helper owns all AX UI
// interaction; this boundary accepts only its strict, one-object JSON protocol.

import { existsSync } from 'fs';
import { join } from 'path';
import { z } from 'zod';
import { bufferedSpawn } from '../../lib/bufferedSpawn.js';
import { getVoiceConfig, voiceHome } from './config.js';
import { isInstanceFeatureEnabled } from '../instanceFeatures.js';
import { ServerError } from '../../lib/errorHandler.js';

export const FACETIME_COMMANDS = ['probe', 'call', 'answer', 'hangup'];
const HELPER_NAME = process.platform === 'win32' ? 'facetime-ax.exe' : 'facetime-ax';
const FACETIME_TIMEOUT_MS = 40_000;

export const facetimeControlResultSchema = z.object({
  ok: z.boolean(),
  command: z.enum(FACETIME_COMMANDS),
  state: z.enum(['idle', 'dialing', 'connected', 'ended', 'unknown']),
  authorized: z.boolean(),
  action: z.string().max(160),
  message: z.string().max(1000),
  errorCode: z.string().max(120).nullable(),
}).strict();

export const facetimeHelperPath = () => join(voiceHome(), HELPER_NAME);

const identityReady = (config) => Boolean(config?.facetime?.targetHandle?.trim() && config?.facetime?.targetName?.trim());

const fact = (ok, message) => ({ ok: ok ? 'ok' : 'missing', message });

export async function checkSetup(config) {
  const voiceConfig = config || await getVoiceConfig();
  const facetime = voiceConfig.facetime || {};
  const helper = facetimeHelperPath();
  return {
    platform: fact(process.platform === 'darwin', 'FaceTime Audio control requires macOS.'),
    helper: fact(existsSync(helper), 'Run npm run setup:facetime to compile the FaceTime helper.'),
    identity: fact(identityReady(voiceConfig), 'Set a target name and E.164 phone number or email address.'),
    accessibility: fact(false, 'Grant Accessibility access to facetime-ax in System Settings > Privacy & Security > Accessibility.'),
    blackHole2ch: fact(false, `Install/select ${facetime.blackHole2chLabel || 'BlackHole 2ch'} in FaceTime audio settings.`),
    blackHole16ch: fact(false, `Install/select ${facetime.blackHole16chLabel || 'BlackHole 16ch'} in FaceTime audio settings.`),
  };
}

const setupFailure = (report) => Object.entries(report).find(([, value]) => value.ok !== 'ok')?.[0] || null;

async function assertAvailable(config) {
  if (!await isInstanceFeatureEnabled('facetime')) {
    throw new ServerError('FaceTime Audio is disabled', { status: 409, code: 'feature-disabled' });
  }
  if (!identityReady(config)) {
    throw new ServerError('FaceTime identity is not configured', { status: 409, code: 'identity' });
  }
}

export async function run(command, config) {
  const voiceConfig = config || await getVoiceConfig();
  if (!FACETIME_COMMANDS.includes(command)) throw new ServerError('Unknown FaceTime command', { status: 400, code: 'VALIDATION_ERROR' });
  await assertAvailable(voiceConfig);
  const report = await checkSetup(voiceConfig);
  const missing = setupFailure(report);
  if (missing) throw new ServerError(`FaceTime setup incomplete: ${missing}`, { status: 409, code: missing });
  const result = await bufferedSpawn(facetimeHelperPath(), [command, voiceConfig.facetime.targetHandle, voiceConfig.facetime.targetName], { timeoutMs: FACETIME_TIMEOUT_MS });
  if (result.timedOut) throw new ServerError('FaceTime helper timed out', { status: 504, code: 'timeout' });
  const parsed = facetimeControlResultSchema.safeParse(JSON.parse(result.stdout));
  if (!parsed.success) throw new ServerError('FaceTime helper returned an invalid result', { status: 502, code: 'invalid-helper-result' });
  if (!result.success || !parsed.data.ok) {
    throw new ServerError(parsed.data.message || 'FaceTime helper failed', { status: 502, code: parsed.data.errorCode || 'helper-failed' });
  }
  return parsed.data;
}

export const probe = () => run('probe');
export const call = () => run('call');
export const answer = () => run('answer');
export const hangup = () => run('hangup');
