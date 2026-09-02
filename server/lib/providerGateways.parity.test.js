/**
 * The gateway registry exists in three places by architecture — the vendored
 * `aiToolkit/` may not import out of its own directory, and the browser cannot
 * import server code at all. This suite pins all three together so a new
 * gateway added to one is never silently missing from another (which would show
 * up as a wrapper that spawns fine but can never refresh its models, or a
 * gateway the server supports that no picker ever offers).
 *
 * The two SERVER copies are compared as VALUES — the toolkit module imports
 * cleanly here, so `toEqual` pins every field including `baseURL`.
 *
 * The client copy (`client/src/utils/providers.js`) is compared as TEXT: it is
 * read with `readFileSync` and its rows are parsed out of the source, never
 * imported, so the client's dependency tree stays out of the server CI job.
 * That comparison is deliberately field-scoped — the browser omits `baseURL`
 * and `legacyApiKeyField` (it never dials the gateway, and it never handles the
 * key), so `toEqual` against the server rows cannot be used. The fields it does
 * carry are all user-visible or dispatch-critical: `id` is the OpenCode
 * namespace AND the sibling-key lookup, `label` and `apiKeyEnv` are rendered in
 * the provider form, and `legacyMarker` is how a pre-registry stored record
 * still resolves.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { PROVIDER_GATEWAYS as SERVER_GATEWAYS } from './providerGateways.js';
import { PROVIDER_GATEWAYS as TOOLKIT_GATEWAYS, gatewayForProvider as toolkitGatewayFor } from './aiToolkit/internal/gateways.js';
import { gatewayForProvider as serverGatewayFor } from './providerGateways.js';
import { extractDeclaration, stripCommentsAndNormalize } from './mirrorParity.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLIENT_PATH = resolve(__dirname, '../../client/src/utils/providers.js');

// The fields the browser copy carries, and the only ones it can be held to.
const CLIENT_FIELDS = ['id', 'label', 'apiKeyEnv', 'legacyMarker'];

const pickClientFields = (row) => Object.fromEntries(
  CLIENT_FIELDS.filter((field) => row[field] !== undefined).map((field) => [field, row[field]]),
);

/**
 * The client registry's rows, parsed from source. Each row is a flat
 * `Object.freeze({ key: 'value', … })` with no nested braces, so a
 * brace-delimited split over the comment-stripped declaration is enough — and
 * anything more structural would mean importing the module, which is the thing
 * this file exists to avoid.
 */
function parseClientGatewayRows() {
  const declaration = extractDeclaration(readFileSync(CLIENT_PATH, 'utf8'), 'PROVIDER_GATEWAYS');
  if (declaration == null) return null;
  return [...stripCommentsAndNormalize(declaration).matchAll(/\{([^{}]*)\}/g)].map(([, body]) =>
    Object.fromEntries([...body.matchAll(/(\w+):\s*'([^']*)'/g)].map(([, key, value]) => [key, value])),
  );
}

describe('providerGateways ↔ aiToolkit/internal/gateways parity', () => {
  it('declares the same rows, in the same order', () => {
    expect(TOOLKIT_GATEWAYS).toEqual(SERVER_GATEWAYS);
  });

  it('resolves the same provider records', () => {
    const records = [
      { gatewayBacked: 'openrouter' },
      { gatewayBacked: 'orcarouter' },
      { orcarouterBacked: true },
      { ollamaBacked: true },
      { gatewayBacked: 'not-a-gateway' },
      null,
    ];
    for (const record of records) {
      expect(toolkitGatewayFor(record)).toEqual(serverGatewayFor(record));
    }
  });
});

describe('providerGateways ↔ client/src/utils/providers.js parity', () => {
  const clientRows = parseClientGatewayRows();

  it('the client declares a parseable PROVIDER_GATEWAYS table', () => {
    expect(clientRows, 'client/src/utils/providers.js is missing: PROVIDER_GATEWAYS').not.toBeNull();
    expect(clientRows.length).toBeGreaterThan(0);
  });

  it('declares the same rows, in the same order (browser-visible fields)', () => {
    expect(
      clientRows,
      'the gateway registry diverged — server/lib/providerGateways.js is authoritative; port the row verbatim (minus baseURL / legacyApiKeyField, which the browser omits)',
    ).toEqual(SERVER_GATEWAYS.map(pickClientFields));
  });
});
