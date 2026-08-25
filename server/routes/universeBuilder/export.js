/**
 * Universe Builder export routes.
 *
 * The route is mounted before crud.js because the CRUD wildcard owns
 * `GET /:id`; keeping this sub-router ahead of it makes the nested export path
 * an explicit part of the route contract.
 */

import { Router } from 'express';
import { asyncHandler } from '../../lib/errorHandler.js';
import { universeMarkdownFilename, universeToMarkdown } from '../../lib/universeMarkdown.js';
import * as svc from '../../services/universeBuilder.js';
import { mapServiceError } from './shared.js';

const router = Router();

router.get('/:id/export/markdown', asyncHandler(async (req, res) => {
  const universe = await svc.getUniverse(req.params.id).catch((err) => {
    throw mapServiceError(err);
  });
  res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${universeMarkdownFilename(universe.name)}"`);
  res.send(universeToMarkdown(universe));
}));

export default router;
