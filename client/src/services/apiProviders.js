import { request } from './apiCore.js';

// Providers
// `options` (e.g. { silent: true }) lets callers that own their own error UI
// suppress the helper's default error toast.
export const getProviders = (options) => request('/providers', options);
export const getActiveProvider = () => request('/providers/active');
export const setActiveProvider = (id) => request('/providers/active', {
  method: 'PUT',
  body: JSON.stringify({ id })
});
export const getProvider = (id) => request(`/providers/${id}`);
export const createProvider = (data) => request('/providers', {
  method: 'POST',
  body: JSON.stringify(data)
});
export const updateProvider = (id, data) => request(`/providers/${id}`, {
  method: 'PUT',
  body: JSON.stringify(data)
});
export const deleteProvider = (id) => request(`/providers/${id}`, { method: 'DELETE' });
export const getSampleProviders = () => request('/providers/samples');
export const testProvider = (id) => request(`/providers/${id}/test`, { method: 'POST' });
export const refreshProviderModels = (id, options) => request(`/providers/${id}/refresh-models`, { method: 'POST', ...options });
// Which provider runtimes (claude, codex, opencode, …) are runnable on this
// host, and which of them PortOS can install for you. Installs happen only
// after an explicit Providers-page click; the status payload carries booleans
// and labels only — never local executable paths.
export const getProviderRuntimes = (options) => request('/providers/runtimes', options);
// Per-provider requirements checklist for providers backed by a LOCAL daemon
// (llama.cpp, Ollama, LM Studio, MTPLX): is it installed, is it running, is it
// serving the model this provider asks for. Keyed by provider id; providers
// with no local dependency are absent from the map.
export const getProviderReadiness = (options) => request('/providers/readiness', options);
// The model-mismatch fix that moves the SERVER rather than the provider:
// llama.cpp serves one model per process under the `--alias` on its launch
// line, so PortOS can relaunch the weights it already has under the id this
// provider sends. The model id is re-derived server-side from the stored
// record — this call names only the provider.
export const serveProviderModel = (id, options) => request(
  `/providers/readiness/serve-model?provider=${encodeURIComponent(id)}`,
  { method: 'POST', ...options },
);

// Provider status (usage limits, availability)
export const getProviderStatuses = () => request('/providers/status');
export const getProviderStatus = (id) => request(`/providers/${id}/status`);
export const recoverProvider = (id, options) => request(`/providers/${id}/status/recover`, { method: 'POST', ...options });
