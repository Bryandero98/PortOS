/** Machine-local IdeaLoom list and settings routes. */

import { Router } from 'express';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validation.js';
import { partialWithoutDefaults } from '../lib/zodCompat.js';
import { ideaLoomListInputSchema, ideaLoomSettingsInputSchema } from '../lib/brainValidation.js';
import * as ideaLoomLists from '../services/idealoomLists.js';

const router = Router();

router.get('/ideas/idealoom/settings', asyncHandler(async (_req, res) => {
  res.json(await ideaLoomLists.getSettings());
}));

router.put('/ideas/idealoom/settings', asyncHandler(async (req, res) => {
  const updates = validateRequest(partialWithoutDefaults(ideaLoomSettingsInputSchema), req.body);
  res.json(await ideaLoomLists.updateSettings(updates));
}));

router.get('/ideas/idealoom/lists', asyncHandler(async (_req, res) => {
  res.json(await ideaLoomLists.listLists());
}));

router.post('/ideas/idealoom/lists', asyncHandler(async (req, res) => {
  const data = validateRequest(ideaLoomListInputSchema, req.body);
  res.status(201).json(await ideaLoomLists.createList(data));
}));

router.get('/ideas/idealoom/lists/:id', asyncHandler(async (req, res) => {
  const list = await ideaLoomLists.getList(req.params.id);
  if (!list) throw new ServerError('IdeaLoom list not found', { status: 404, code: 'NOT_FOUND' });
  res.json(list);
}));

router.put('/ideas/idealoom/lists/:id', asyncHandler(async (req, res) => {
  const updates = validateRequest(partialWithoutDefaults(ideaLoomListInputSchema), req.body);
  const list = await ideaLoomLists.updateList(req.params.id, updates);
  if (!list) throw new ServerError('IdeaLoom list not found', { status: 404, code: 'NOT_FOUND' });
  res.json(list);
}));

router.delete('/ideas/idealoom/lists/:id', asyncHandler(async (req, res) => {
  if (!await ideaLoomLists.deleteList(req.params.id)) {
    throw new ServerError('IdeaLoom list not found', { status: 404, code: 'NOT_FOUND' });
  }
  res.status(204).send();
}));

export default router;
