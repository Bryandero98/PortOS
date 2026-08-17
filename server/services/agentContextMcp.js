import { createHash } from 'crypto';
import { getSettings } from './settings.js';
import { BRAIN_SEARCH_TYPES, getBrainProjections } from './brainSearchIndex.js';
import { listContexts } from './workspaceContext.js';
import { previewLegacyExport, redactSecrets } from './legacyExport.js';
import { NAV_COMMANDS, resolveNavCommand } from '../lib/navManifest.js';
import {
  AGENT_CONTEXT_DEFAULT_SCOPES,
  AGENT_CONTEXT_LIMITS,
  AGENT_CONTEXT_PROTOCOL_VERSION,
  AGENT_CONTEXT_SCHEMA_VERSION,
  AGENT_CONTEXT_TOOL_REGISTRY,
  advertiseAgentContextTools,
  agentContextSettingsSchema,
} from '../lib/agentContextValidation.js';

export const AGENT_CONTEXT_EXCLUSIONS = Object.freeze([
  'Privacy Vault and encrypted privacy records',
  'credentials, secrets, tokens, and authentication material',
  'federation peers, network topology, and machine identity',
  'repository paths, branches, shell sessions, and command history',
  'messages, browser history, health records, and raw personal exports',
]);

const stableId = (value) => createHash('sha256').update(String(value)).digest('hex').slice(0, 20);
const cap = (value, max) => String(value ?? '').slice(0, max);
const normalizedText = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
const searchableText = (value) => normalizedText(value).slice(0, 2_000);

export function redactAgentContextText(value) {
  return cap(redactSecrets(normalizedText(value))
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[REDACTED EMAIL]')
    .replace(/\b[A-Z0-9-]+(?:\.[A-Z0-9-]+)*\.ts\.net\b/gi, '[REDACTED HOST]')
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[REDACTED IP]')
    .replace(/\b(?:[A-F0-9]{1,4}:){2,7}[A-F0-9]{0,4}\b/gi, '[REDACTED IP]')
    .replace(/\b(?:[A-F0-9]{2}:){5}[A-F0-9]{2}\b/gi, '[REDACTED MAC]')
    .replace(/(?:\/Users\/|\/home\/)[^/\s]+/g, '~')
    .replace(/\b(?:\+?\d[\d ().-]{8,}\d)\b/g, '[REDACTED PHONE]')
    .replace(/\b(?:latitude|lat)\s*[:=]\s*-?\d{1,3}(?:\.\d+)?/gi, 'latitude=[REDACTED]')
    .replace(/\b(?:longitude|lon|lng)\s*[:=]\s*-?\d{1,3}(?:\.\d+)?/gi, 'longitude=[REDACTED]'),
  AGENT_CONTEXT_LIMITS.maxSummaryChars);
}

export function resolveAgentContextConfig(settings = {}) {
  const parsed = agentContextSettingsSchema.safeParse(settings.agentContext ?? {});
  if (!parsed.success) {
    return {
      enabled: false,
      profile: 'metadata',
      scopes: [...AGENT_CONTEXT_DEFAULT_SCOPES],
      invalid: true,
    };
  }
  return {
    enabled: parsed.data.enabled ?? false,
    profile: parsed.data.profile ?? 'metadata',
    scopes: parsed.data.scopes ?? [...AGENT_CONTEXT_DEFAULT_SCOPES],
    invalid: false,
  };
}

const navigationItem = (entry) => ({
  item: {
    ref: `navigation:${entry.id}`,
    scope: 'navigation',
    kind: 'page',
    title: cap(entry.label, 160),
    summary: cap(`${entry.section} page in PortOS.`, AGENT_CONTEXT_LIMITS.maxSummaryChars),
    path: cap(entry.path, 300),
  },
  searchText: searchableText([entry.label, entry.section, ...(entry.aliases ?? []), ...(entry.keywords ?? [])].join(' ')),
});

const workspaceItem = (workspace, profile) => ({
  item: {
    ref: `workspaces:workspace:${stableId(workspace.appId)}`,
    scope: 'workspaces',
    kind: 'workspace',
    title: profile === 'summary' ? cap(redactAgentContextText(workspace.appName), 160) : 'Workspace',
    summary: cap(`Active workspace with ${Number(workspace.taskCount) || 0} task(s).`, AGENT_CONTEXT_LIMITS.maxSummaryChars),
    path: '/apps',
  },
  searchText: searchableText(`${workspace.appName} workspace app ${workspace.appId}`),
});

const brainText = (record) => Object.entries(record)
  .filter(([key, value]) => key !== 'id' && key !== '_rank' && typeof value === 'string')
  .map(([, value]) => value)
  .join(' ');

const brainItem = (type, record, profile) => {
  const raw = brainText(record);
  const firstLabel = record.name || record.title || record.oneLiner || record.capturedText || `${type} record`;
  return {
    item: {
      ref: `brain:${type}:${stableId(record.id)}`,
      scope: 'brain',
      kind: type,
      title: profile === 'summary' ? cap(redactAgentContextText(firstLabel), 160) : `${type} record`,
      summary: profile === 'summary'
        ? redactAgentContextText(raw || `Read-only ${type} record.`)
        : `Read-only ${type} record metadata.`,
      path: cap(`/brain/${type}`, 300),
    },
    searchText: searchableText(`${type} ${raw}`),
  };
};

const identityItem = ([key, section]) => ({
  item: {
    ref: `identity:section:${key}`,
    scope: 'identity',
    kind: 'identity-export-section',
    title: cap(section.label || key, 160),
    summary: cap(section.present
      ? 'Present in the local identity export; raw records are excluded.'
      : 'No local identity-export data is present for this section.', AGENT_CONTEXT_LIMITS.maxSummaryChars),
    path: '/digital-twin/time-capsule',
  },
  searchText: searchableText(`${key} ${section.label || ''} identity export ${section.present ? 'present' : 'absent'}`),
});

const SOURCE_LOADERS = Object.freeze({
  navigation: async () => ({
    items: NAV_COMMANDS.slice(0, AGENT_CONTEXT_LIMITS.maxSourceItems).map(navigationItem),
    sourceTruncated: NAV_COMMANDS.length > AGENT_CONTEXT_LIMITS.maxSourceItems,
  }),
  workspaces: async (profile) => {
    const workspaces = await listContexts();
    return {
      items: workspaces.slice(0, AGENT_CONTEXT_LIMITS.maxSourceItems)
        .map((item) => workspaceItem(item, profile)),
      sourceTruncated: workspaces.length > AGENT_CONTEXT_LIMITS.maxSourceItems,
    };
  },
  brain: async (profile) => {
    const byType = await Promise.all(BRAIN_SEARCH_TYPES.map(async (type) => ({
      type,
      records: await getBrainProjections(type),
    })));
    const candidates = [];
    for (const { type, records } of byType) {
      const remaining = AGENT_CONTEXT_LIMITS.maxSourceItems - candidates.length;
      if (remaining <= 0) break;
      candidates.push(...records.slice(0, remaining).map((record) => brainItem(type, record, profile)));
    }
    return {
      items: candidates,
      sourceTruncated: byType.reduce((total, entry) => total + entry.records.length, 0) > candidates.length,
    };
  },
  identity: async () => {
    const sections = Object.entries((await previewLegacyExport()).sections ?? {});
    return {
      items: sections.slice(0, AGENT_CONTEXT_LIMITS.maxSourceItems).map(identityItem),
      sourceTruncated: sections.length > AGENT_CONTEXT_LIMITS.maxSourceItems,
    };
  },
});

const loadItems = async (config, scopes) => {
  const sources = await Promise.all(scopes.map(async (scope) => {
    const loader = SOURCE_LOADERS[scope];
    if (!loader) throw new Error(`Unsupported context scope: ${scope}`);
    return loader(config.profile);
  }));
  return {
    items: sources.flatMap((source) => source.items),
    sourceTruncated: sources.some((source) => source.sourceTruncated),
  };
};

const requestedScopes = (config, scopes) => {
  const requested = scopes ?? config.scopes;
  const unavailable = requested.filter((scope) => !config.scopes.includes(scope));
  if (unavailable.length > 0) throw new Error(`Context scope is not enabled: ${unavailable.join(', ')}`);
  return requested;
};

const fitItems = (items, limit) => {
  const selected = [];
  for (const candidate of items.slice(0, limit)) {
    const next = [...selected, candidate.item];
    if (JSON.stringify(next).length > AGENT_CONTEXT_LIMITS.maxResponseChars) break;
    selected.push(candidate.item);
  }
  return { items: selected, truncated: selected.length < items.length };
};

const profileOutput = (config) => ({
  profile: config.profile,
  scopes: config.scopes,
  limits: {
    defaultResults: AGENT_CONTEXT_LIMITS.defaultResults,
    maxResults: AGENT_CONTEXT_LIMITS.maxResults,
    maxSummaryChars: AGENT_CONTEXT_LIMITS.maxSummaryChars,
    maxResponseChars: AGENT_CONTEXT_LIMITS.maxResponseChars,
    maxSourceItems: AGENT_CONTEXT_LIMITS.maxSourceItems,
  },
  exclusions: [...AGENT_CONTEXT_EXCLUSIONS],
});

const TOOL_HANDLERS = Object.freeze({
  search_context: async (input, config) => {
    const scopes = requestedScopes(config, input.scopes);
    const query = input.query.toLowerCase();
    const loaded = await loadItems(config, scopes);
    const matches = loaded.items
      .filter((candidate) => candidate.searchText.toLowerCase().includes(query));
    const fitted = fitItems(matches, input.limit ?? AGENT_CONTEXT_LIMITS.defaultResults);
    return {
      ...fitted,
      total: matches.length,
      sourceTruncated: loaded.sourceTruncated,
      truncated: fitted.truncated || loaded.sourceTruncated,
    };
  },
  get_context: async (input, config) => {
    const scope = input.ref.split(':', 1)[0];
    if (!config.scopes.includes(scope)) return { item: null, sourceTruncated: false };
    const loaded = await loadItems(config, [scope]);
    return {
      item: loaded.items.find((candidate) => candidate.item.ref === input.ref)?.item ?? null,
      sourceTruncated: loaded.sourceTruncated,
    };
  },
  list_context: async (input, config) => {
    requestedScopes(config, [input.scope]);
    const loaded = await loadItems(config, [input.scope]);
    const all = loaded.items;
    const cursor = input.cursor ?? 0;
    const page = all.slice(cursor);
    const fitted = fitItems(page, input.limit ?? AGENT_CONTEXT_LIMITS.defaultResults);
    const nextOffset = cursor + fitted.items.length;
    return {
      ...fitted,
      total: all.length,
      nextCursor: nextOffset < all.length ? nextOffset : null,
      sourceTruncated: loaded.sourceTruncated,
      truncated: fitted.truncated || loaded.sourceTruncated,
    };
  },
  resolve_navigation: async (input, config) => {
    requestedScopes(config, ['navigation']);
    const match = resolveNavCommand(input.query);
    return { match: match?.command ? navigationItem(match.command).item : null };
  },
  context_profile: async (_input, config) => profileOutput(config),
});

const errorToolResult = (message) => ({
  isError: true,
  content: [{ type: 'text', text: cap(message, 500) }],
});

const successToolResult = (output) => ({
  content: [{ type: 'text', text: JSON.stringify(output) }],
  structuredContent: output,
});

export async function getAgentContextManifest(settings) {
  const current = settings ?? await getSettings();
  const config = resolveAgentContextConfig(current);
  return {
    kind: 'portos-agent-context',
    schemaVersion: AGENT_CONTEXT_SCHEMA_VERSION,
    protocolVersion: AGENT_CONTEXT_PROTOCOL_VERSION,
    enabled: config.enabled,
    configurationValid: !config.invalid,
    transport: {
      type: 'streamable-http',
      endpoint: '/api/agent-context/mcp',
      loopbackOnly: true,
      stateful: false,
    },
    profile: config.profile,
    scopes: config.scopes,
    limits: profileOutput(config).limits,
    exclusions: [...AGENT_CONTEXT_EXCLUSIONS],
    tools: advertiseAgentContextTools(config.scopes),
  };
}

export async function callAgentContextTool(name, args, settings) {
  const current = settings ?? await getSettings();
  const config = resolveAgentContextConfig(current);
  if (!config.enabled || config.invalid) return errorToolResult('Agent context is disabled or invalid.');

  const tool = AGENT_CONTEXT_TOOL_REGISTRY.find((candidate) => candidate.name === name);
  if (!tool || !TOOL_HANDLERS[name]) return errorToolResult(`Unknown tool: ${cap(name, 120)}`);
  if (tool.requiredScope && !config.scopes.includes(tool.requiredScope)) {
    return errorToolResult(`Tool requires the ${tool.requiredScope} scope.`);
  }

  const parsed = tool.inputSchema.safeParse(args ?? {});
  if (!parsed.success) {
    const paths = parsed.error.issues.map((issue) => issue.path.join('.') || 'input').join(', ');
    return errorToolResult(`Invalid tool input at: ${paths}`);
  }

  return Promise.resolve(TOOL_HANDLERS[name](parsed.data, config))
    .then((output) => successToolResult(tool.outputSchema.parse(output)))
    .catch(() => errorToolResult('Context source unavailable for this request.'));
}
