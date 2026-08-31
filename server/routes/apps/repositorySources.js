/**
 * Managed repository topology and upstream actions for integrations composed
 * from more than one checkout.
 *
 *   GET  /:id/repository-sources           → versions and origin/upstream state
 *   POST /:id/repository-sources/sync-fork → fast-forward the Worlds fork only
 *
 * The first integration is Eidoverse. Keeping this on the app-management
 * surface makes the companion runtime visible without pretending it is a git
 * submodule or exposing machine-local checkout paths to the browser.
 */

import { Router } from 'express';
import { asyncHandler } from '../../lib/errorHandler.js';
import {
  getEidoverseRepositorySources,
  syncEidoverseWorldsFork,
} from '../../services/eidoverseRepositories.js';
import { loadApp } from './shared.js';

const router = Router();

router.get('/:id/repository-sources', loadApp, asyncHandler(async (req, res) => {
  res.json(await getEidoverseRepositorySources(req.loadedApp));
}));

router.post('/:id/repository-sources/sync-fork', loadApp, asyncHandler(async (req, res) => {
  res.json(await syncEidoverseWorldsFork(req.loadedApp));
}));

export default router;
