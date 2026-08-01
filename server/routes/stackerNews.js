import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validation.js';
import * as stackerNews from '../services/stackerNews.js';

const router = Router();
const uuid = z.string().uuid();
const rules = z.record(z.unknown()).optional();
const accountSchema = z.object({
  label: z.string().trim().min(1).max(120),
  username: z.string().trim().min(1).max(80).regex(/^[a-zA-Z0-9_-]+$/, 'must be a Stacker News username'),
  apiKey: z.string().trim().min(1).max(400).optional(),
  enabled: z.boolean().optional(),
  monitoringEnabled: z.boolean().optional(),
  textModel: z.string().trim().max(200).optional(),
  visionModel: z.string().trim().max(200).optional(),
  rules,
});
const accountUpdateSchema = accountSchema.partial().extend({ apiKey: z.string().trim().max(400).optional() });
const territorySchema = z.object({
  accountId: uuid,
  slug: z.string().trim().min(1).max(120).regex(/^[a-zA-Z0-9_-]+$/),
  label: z.string().trim().max(160).optional(),
  isOwned: z.boolean().optional(),
  rules,
  remoteSettings: z.record(z.unknown()).optional(),
});
const itemSchema = z.object({
  accountId: uuid,
  territoryId: uuid.nullable().optional(),
  remoteId: z.string().trim().min(1).max(200),
  kind: z.enum(['post', 'comment']),
  authorName: z.string().max(120).optional(),
  title: z.string().max(2000).optional(),
  body: z.string().max(40_000).optional(),
  sourceUrl: z.string().url().max(2000).optional(),
  imageUrls: z.array(z.string().url().max(2000)).max(12).optional(),
});
const actionSchema = z.object({
  accountId: uuid,
  itemId: uuid.nullable().optional(),
  territoryId: uuid.nullable().optional(),
  kind: z.enum(['draft_post', 'draft_comment', 'publish_post', 'publish_comment', 'open_browser', 'territory_setting']),
  payload: z.record(z.unknown()).optional(),
});
const reviewSchema = z.object({ state: z.enum(['approved', 'rejected']), reviewNote: z.string().max(2000).optional() });

const requireId = (value, label = 'ID') => {
  if (!uuid.safeParse(value).success) throw new ServerError(`Invalid ${label}`, { status: 400 });
};

router.get('/accounts', asyncHandler(async (_req, res) => {
  res.json({ accounts: await stackerNews.listAccounts() });
}));

router.post('/accounts', asyncHandler(async (req, res) => {
  const account = await stackerNews.createAccount(validateRequest(accountSchema, req.body));
  req.app.get('io')?.emit('stacker-news:changed', { accountId: account.id });
  res.status(201).json(account);
}));

router.get('/accounts/:id', asyncHandler(async (req, res) => {
  requireId(req.params.id, 'account ID');
  const account = await stackerNews.getAccount(req.params.id);
  if (!account) throw new ServerError('Stacker News account not found', { status: 404 });
  res.json(account);
}));

router.patch('/accounts/:id', asyncHandler(async (req, res) => {
  requireId(req.params.id, 'account ID');
  const account = await stackerNews.updateAccount(req.params.id, validateRequest(accountUpdateSchema, req.body));
  if (!account) throw new ServerError('Stacker News account not found', { status: 404 });
  req.app.get('io')?.emit('stacker-news:changed', { accountId: account.id });
  res.json(account);
}));

router.delete('/accounts/:id', asyncHandler(async (req, res) => {
  requireId(req.params.id, 'account ID');
  if (!await stackerNews.deleteAccount(req.params.id)) throw new ServerError('Stacker News account not found', { status: 404 });
  req.app.get('io')?.emit('stacker-news:changed', { accountId: req.params.id });
  res.status(204).send();
}));

router.post('/accounts/:id/verify', asyncHandler(async (req, res) => {
  requireId(req.params.id, 'account ID');
  const status = await stackerNews.verifyConnection(req.params.id);
  if (!status) throw new ServerError('Stacker News account not found', { status: 404 });
  res.json(status);
}));

router.get('/accounts/:id/territories', asyncHandler(async (req, res) => {
  requireId(req.params.id, 'account ID');
  res.json({ territories: await stackerNews.listTerritories(req.params.id) });
}));

router.post('/territories', asyncHandler(async (req, res) => {
  const territory = await stackerNews.createTerritory(validateRequest(territorySchema, req.body));
  req.app.get('io')?.emit('stacker-news:changed', { accountId: territory.accountId });
  res.status(201).json(territory);
}));

router.patch('/territories/:id', asyncHandler(async (req, res) => {
  requireId(req.params.id, 'territory ID');
  const data = validateRequest(territorySchema.omit({ accountId: true }).partial(), req.body);
  const territory = await stackerNews.updateTerritory(req.params.id, data);
  if (!territory) throw new ServerError('Stacker News territory not found', { status: 404 });
  req.app.get('io')?.emit('stacker-news:changed', { accountId: territory.accountId });
  res.json(territory);
}));

router.delete('/territories/:id', asyncHandler(async (req, res) => {
  requireId(req.params.id, 'territory ID');
  if (!await stackerNews.deleteTerritory(req.params.id)) throw new ServerError('Stacker News territory not found', { status: 404 });
  res.status(204).send();
}));

router.get('/accounts/:id/items', asyncHandler(async (req, res) => {
  requireId(req.params.id, 'account ID');
  res.json({ items: await stackerNews.listItems(req.params.id) });
}));

router.post('/items', asyncHandler(async (req, res) => {
  const item = await stackerNews.ingestItem(validateRequest(itemSchema, req.body));
  res.status(201).json(item);
}));

router.post('/items/:id/analyze', asyncHandler(async (req, res) => {
  requireId(req.params.id, 'item ID');
  const analysis = await stackerNews.analyzeItem(req.params.id);
  if (!analysis) throw new ServerError('Stacker News item not found', { status: 404 });
  res.json(analysis);
}));

router.get('/items/:id/analyses', asyncHandler(async (req, res) => {
  requireId(req.params.id, 'item ID');
  res.json({ analyses: await stackerNews.listAnalyses(req.params.id) });
}));

router.get('/accounts/:id/actions', asyncHandler(async (req, res) => {
  requireId(req.params.id, 'account ID');
  res.json({ actions: await stackerNews.listActions(req.params.id) });
}));

router.post('/actions', asyncHandler(async (req, res) => {
  const action = await stackerNews.createAction(validateRequest(actionSchema, req.body));
  req.app.get('io')?.emit('stacker-news:changed', { accountId: action.accountId });
  res.status(201).json(action);
}));

router.post('/actions/:id/review', asyncHandler(async (req, res) => {
  requireId(req.params.id, 'action ID');
  const { state, reviewNote } = validateRequest(reviewSchema, req.body);
  const action = await stackerNews.updateActionState(req.params.id, state, reviewNote);
  if (!action) throw new ServerError('Action is not pending review', { status: 409 });
  req.app.get('io')?.emit('stacker-news:changed', { accountId: action.accountId });
  res.json(action);
}));

export default router;
