import { fetchWithTimeout } from '../../lib/fetchWithTimeout.js';

const ENDPOINT = 'https://stacker.news/api/graphql';
const TIMEOUT_MS = 12_000;

// The adapter deliberately exposes a closed registry: callers cannot relay
// model-supplied GraphQL, variables, or target URLs through this boundary.
const OPERATIONS = {
  me: {
    query: 'query StackerNewsMe { me { name } }',
    variables: () => ({}),
  },
  territory: {
    query: 'query StackerNewsTerritory($slug: String!) { territory(slug: $slug) { id name slug postsSatsFilter baseCost } }',
    variables: ({ slug }) => ({ slug }),
  },
};

export async function executeStackerNewsOperation(name, input, apiKey) {
  const operation = OPERATIONS[name];
  if (!operation) throw new Error(`Unsupported Stacker News operation: ${name}`);
  if (!apiKey) throw new Error('Stacker News API key is not configured');
  const response = await fetchWithTimeout(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
    body: JSON.stringify({ query: operation.query, variables: operation.variables(input) }),
  }, TIMEOUT_MS);
  const payload = await response.json();
  if (!response.ok || payload.errors?.length) {
    throw new Error(payload.errors?.[0]?.message || `Stacker News request failed (${response.status})`);
  }
  return payload.data;
}

export const stackerNewsOperations = Object.freeze(Object.keys(OPERATIONS));
