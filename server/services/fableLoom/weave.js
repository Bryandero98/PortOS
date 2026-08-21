/**
 * FableLoom AI operations — weave (generate a full episode graph), branch
 * (grow new paths out of one scene), review (LLM story critique layered over
 * the deterministic graph analysis), and play (resolve a reader's free-text
 * intent into a graph transition).
 *
 * Every call here is triggered by a direct user action in the same request
 * (button click / chat message), per the AI Provider Usage Policy — nothing
 * fires at boot or in the background. LLM execution rides `runStagedLLM`, so
 * provider/model resolution, run records, and JSON extraction follow the same
 * rules as every other stage. Generated content is passed to `mutateLoom`
 * raw — the record sanitizer owns id minting, trims, and caps.
 */

import { randomUUID } from 'crypto';
import { ServerError } from '../../lib/errorHandler.js';
import { runStagedLLM } from '../../lib/stageRunner.js';
import { isStr, trimTo } from '../../lib/storyBible.js';
import { renderCanonForPrompt } from '../../lib/universePromptRenderers.js';
import { analyzeEpisodeGraph, describeGraphForPrompt } from '../../lib/fableLoomGraph.js';
import { getUniverse } from '../universeBuilder.js';
import { LOOM_LIMITS, findEpisode, findNode, getLoom, mutateLoom } from './records.js';

const TRANSCRIPT_TURNS_MAX = 12;

const clamp = (value, min, max, fallback) =>
  (Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback);

const aiShapeError = (message) =>
  new ServerError(message, { status: 502, code: 'AI_RESPONSE_INVALID' });

const requireLoom = async (loomId) => {
  const loom = await getLoom(loomId);
  if (!loom) throw new ServerError('Loom not found', { status: 404, code: 'NOT_FOUND' });
  return loom;
};

const llmOptions = ({ providerId, model } = {}, source) => ({
  source,
  returnsJson: true,
  ...(providerId ? { providerOverride: providerId } : {}),
  ...(model ? { modelOverride: model } : {}),
});

/**
 * Render the linked universe's canon as a prompt digest via the shared
 * renderer (field precedence, per-kind caps, and the "+ N more" truncation
 * footer every generative prompt gets). Empty string when the loom has no
 * universe — the stages treat it as optional.
 */
export async function buildCanonDigest(loom) {
  if (!loom.universeId) return '';
  const universe = await getUniverse(loom.universeId).catch(() => null);
  return universe ? renderCanonForPrompt(universe) : '';
}

const storyContext = (loom, episode) => [
  `Story: ${loom.name}`,
  loom.logline ? `Logline: ${loom.logline}` : '',
  loom.premise ? `Premise: ${loom.premise}` : '',
  episode ? `Episode ${episode.number}: ${episode.title || 'Untitled'}` : '',
  episode?.synopsis ? `Synopsis: ${episode.synopsis}` : '',
].filter(Boolean).join('\n');

// --- Weave: generate a full episode graph -----------------------------------

// Raw generated node fields, passed through for the sanitizer to trim/cap.
const generatedNodeFields = (raw) => ({
  title: raw.title,
  prose: raw.prose,
  imagePrompt: raw.imagePrompt,
  isEnding: raw.isEnding === true,
  endingLabel: raw.endingLabel,
});

/**
 * Map an LLM graph (`{ startKey, nodes: [{ key, …, transitions: [{ targetKey,
 * … }] }] }`) onto server-minted node ids. Transitions pointing at unknown
 * keys or back at their own node are dropped. Throws AI_RESPONSE_INVALID when
 * the shape is unusable (too few scenes, no ending).
 */
export function mapGeneratedGraph(parsed) {
  const rawNodes = Array.isArray(parsed?.nodes) ? parsed.nodes.filter((n) => n && typeof n === 'object' && isStr(n.key)) : [];
  if (rawNodes.length < 2) throw aiShapeError('The model returned too few scenes to form a story graph');
  const idByKey = new Map();
  for (const raw of rawNodes.slice(0, LOOM_LIMITS.NODES_MAX)) {
    if (!idByKey.has(raw.key)) idByKey.set(raw.key, `node-${randomUUID()}`);
  }
  const nodes = rawNodes.slice(0, LOOM_LIMITS.NODES_MAX).map((raw) => ({
    id: idByKey.get(raw.key),
    ...generatedNodeFields(raw),
    transitions: (Array.isArray(raw.transitions) ? raw.transitions : [])
      .filter((t) => t && typeof t === 'object' && idByKey.has(t.targetKey) && idByKey.get(t.targetKey) !== idByKey.get(raw.key))
      .map(({ targetKey, intent, triggers, description }) => ({
        targetNodeId: idByKey.get(targetKey), intent, triggers, description,
      })),
    pos: null,
  }));
  if (!nodes.some((n) => n.isEnding)) throw aiShapeError('The model returned a graph with no endings');
  const startNodeId = idByKey.get(parsed?.startKey) ?? nodes[0].id;
  return { nodes, startNodeId };
}

export async function weaveEpisode(loomId, episodeId, {
  guidance = '', nodeTarget, endingTarget, replace = false, providerId, model,
} = {}) {
  const loom = await requireLoom(loomId);
  const episode = findEpisode(loom, episodeId);
  if (episode.nodes.length && !replace) {
    throw new ServerError('Episode already has scenes — pass replace to regenerate', { status: 409, code: 'EPISODE_NOT_EMPTY' });
  }
  const canonDigest = await buildCanonDigest(loom);
  const { content, runId } = await runStagedLLM('fableloom-weave-episode', {
    storyContext: storyContext(loom, episode),
    canonDigest: canonDigest || '(none — invent what the story needs)',
    guidance: guidance || '(none)',
    nodeTarget: String(clamp(nodeTarget, 3, 60, 12)),
    endingTarget: String(clamp(endingTarget, 1, 12, 3)),
  }, llmOptions({ providerId, model }, 'fableloom-weave'));

  const { nodes, startNodeId } = mapGeneratedGraph(content);
  const updated = await mutateLoom(loomId, (current) => {
    const ep = findEpisode(current, episodeId);
    ep.nodes = nodes;
    ep.startNodeId = startNodeId;
    ep.updatedAt = new Date().toISOString();
    return current;
  });
  return { loom: updated, episodeId, runId };
}

// --- Branch: grow new paths out of one scene --------------------------------

export async function branchNode(loomId, episodeId, nodeId, {
  guidance = '', branchCount, providerId, model,
} = {}) {
  const loom = await requireLoom(loomId);
  const episode = findEpisode(loom, episodeId);
  const node = findNode(episode, nodeId);
  const count = clamp(branchCount, 1, 4, 2);

  const canonDigest = await buildCanonDigest(loom);
  const { content, runId } = await runStagedLLM('fableloom-branch-node', {
    storyContext: storyContext(loom, episode),
    canonDigest: canonDigest || '(none — invent what the story needs)',
    graphDigest: describeGraphForPrompt(episode, { proseLimit: 200 }),
    sceneTitle: node.title || 'Untitled scene',
    sceneProse: node.prose || '(no prose yet)',
    branchCount: String(count),
    guidance: guidance || '(none)',
  }, llmOptions({ providerId, model }, 'fableloom-branch'));

  const branches = Array.isArray(content?.branches)
    ? content.branches.filter((b) => b && typeof b === 'object' && b.node && typeof b.node === 'object').slice(0, count)
    : [];
  if (!branches.length) throw aiShapeError('The model returned no usable branches');

  const updated = await mutateLoom(loomId, (current) => {
    const ep = findEpisode(current, episodeId);
    const source = findNode(ep, nodeId);
    for (const branch of branches) {
      if (ep.nodes.length >= LOOM_LIMITS.NODES_MAX) break;
      const newNode = { id: `node-${randomUUID()}`, ...generatedNodeFields(branch.node), transitions: [], pos: null };
      ep.nodes.push(newNode);
      source.transitions = [...(source.transitions || []), {
        targetNodeId: newNode.id,
        intent: branch.intent,
        triggers: branch.triggers,
        description: branch.description,
      }];
    }
    ep.updatedAt = new Date().toISOString();
    return current;
  });
  return { loom: updated, episodeId, nodeId, runId };
}

// --- Review: LLM critique over the deterministic analysis -------------------

const REVIEW_SEVERITIES = new Set(['high', 'medium', 'low']);

export async function reviewEpisode(loomId, episodeId, { providerId, model } = {}) {
  const loom = await requireLoom(loomId);
  const episode = findEpisode(loom, episodeId);
  const structural = analyzeEpisodeGraph(episode);
  const { content, runId } = await runStagedLLM('fableloom-review', {
    storyContext: storyContext(loom, episode),
    graphDigest: describeGraphForPrompt(episode),
    structuralDigest: structural.issues.length
      ? structural.issues.map((i) => `- [${i.severity}] ${i.message}`).join('\n')
      : '(no structural issues)',
  }, llmOptions({ providerId, model }, 'fableloom-review'));

  const nodeIds = new Set(episode.nodes.map((n) => n.id));
  const findings = (Array.isArray(content?.findings) ? content.findings : [])
    .filter((f) => f && typeof f === 'object' && isStr(f.problem))
    .map((f) => ({
      severity: REVIEW_SEVERITIES.has(f.severity) ? f.severity : 'medium',
      nodeId: nodeIds.has(f.nodeId) ? f.nodeId : null,
      problem: trimTo(f.problem, 1000),
      suggestion: trimTo(f.suggestion, 1000),
    }));
  return {
    structural,
    review: { summary: trimTo(content?.summary, 2000), findings },
    runId,
  };
}

// --- Play: resolve a reader's free-text intent ------------------------------

/** Reader-facing scene shape — trigger phrases stay server-side. */
export const publicNode = (node) => ({
  id: node.id,
  title: node.title,
  prose: node.prose,
  image: node.image,
  isEnding: node.isEnding,
  endingLabel: node.endingLabel,
  choices: (node.transitions || []).map((t) => ({ id: t.id, intent: t.intent })),
});

const transcriptDigest = (transcript) =>
  (Array.isArray(transcript) ? transcript : [])
    .filter((t) => t && typeof t === 'object' && isStr(t.text))
    .slice(-TRANSCRIPT_TURNS_MAX)
    .map((t) => `${t.role === 'reader' ? 'Reader' : 'Narrator'}: ${trimTo(t.text, 500)}`)
    .join('\n');

export async function playTurn(loomId, episodeId, {
  nodeId, message, transcript = [], providerId, model,
} = {}) {
  const loom = await requireLoom(loomId);
  const episode = findEpisode(loom, episodeId);
  const node = findNode(episode, nodeId);
  if (node.isEnding || !(node.transitions || []).length) {
    return { action: 'stay', narration: '', node: publicNode(node), ended: true };
  }

  const choicesDigest = node.transitions.map((t) => [
    `- id: ${t.id}`,
    `  intent: ${t.intent}`,
    t.triggers.length ? `  example phrasings: ${t.triggers.join('; ')}` : null,
    t.description ? `  leads to: ${t.description}` : null,
  ].filter(Boolean).join('\n')).join('\n');

  const { content } = await runStagedLLM('fableloom-play-turn', {
    storyContext: storyContext(loom, episode),
    sceneProse: node.prose || node.title || '',
    choicesDigest,
    transcriptDigest: transcriptDigest(transcript) || '(start of the read-through)',
    readerMessage: trimTo(message, 1000),
  }, llmOptions({ providerId, model }, 'fableloom-play'));

  const narration = trimTo(content?.narration, 4000);
  const chosen = content?.action === 'move'
    ? node.transitions.find((t) => t.id === content?.transitionId)
    : null;
  // No usable choice — including a dangling edge whose target was deleted —
  // stays in place rather than crashing the read.
  const next = chosen ? episode.nodes.find((n) => n.id === chosen.targetNodeId) : null;
  if (!next) {
    return { action: 'stay', narration, node: publicNode(node), ended: false };
  }
  return {
    action: 'move',
    transitionId: chosen.id,
    narration,
    node: publicNode(next),
    ended: next.isEnding === true,
  };
}
