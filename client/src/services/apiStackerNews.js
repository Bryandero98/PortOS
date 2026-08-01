import { request } from './apiCore.js';

export const getStackerNewsAccounts = (options = {}) => request('/stacker-news/accounts', options);
export const getStackerNewsAccount = (id, options = {}) => request(`/stacker-news/accounts/${id}`, options);
export const createStackerNewsAccount = (data, options = {}) => request('/stacker-news/accounts', { method: 'POST', body: JSON.stringify(data), ...options });
export const updateStackerNewsAccount = (id, data, options = {}) => request(`/stacker-news/accounts/${id}`, { method: 'PATCH', body: JSON.stringify(data), ...options });
export const deleteStackerNewsAccount = (id, options = {}) => request(`/stacker-news/accounts/${id}`, { method: 'DELETE', ...options });
export const verifyStackerNewsAccount = (id, options = {}) => request(`/stacker-news/accounts/${id}/verify`, { method: 'POST', ...options });
export const getStackerNewsTerritories = (accountId, options = {}) => request(`/stacker-news/accounts/${accountId}/territories`, options);
export const createStackerNewsTerritory = (data, options = {}) => request('/stacker-news/territories', { method: 'POST', body: JSON.stringify(data), ...options });
export const updateStackerNewsTerritory = (id, data, options = {}) => request(`/stacker-news/territories/${id}`, { method: 'PATCH', body: JSON.stringify(data), ...options });
export const deleteStackerNewsTerritory = (id, options = {}) => request(`/stacker-news/territories/${id}`, { method: 'DELETE', ...options });
export const getStackerNewsItems = (accountId, options = {}) => request(`/stacker-news/accounts/${accountId}/items`, options);
export const getStackerNewsActions = (accountId, options = {}) => request(`/stacker-news/accounts/${accountId}/actions`, options);
export const createStackerNewsAction = (data, options = {}) => request('/stacker-news/actions', { method: 'POST', body: JSON.stringify(data), ...options });
export const reviewStackerNewsAction = (id, data, options = {}) => request(`/stacker-news/actions/${id}/review`, { method: 'POST', body: JSON.stringify(data), ...options });
