import { Router } from 'express';
import { asyncHandler, sendErrorResponse, ServerError } from '../lib/errorHandler.js';
import { validateRequest, restoreRequestSchema, restoreDbRequestSchema } from '../lib/validation.js';
import * as backup from '../services/backup.js';
import { getSettings } from '../services/settings.js';

const router = Router();

// GET /api/backup/status
router.get('/status', asyncHandler(async (req, res) => {
  const state = await backup.getState();
  const settings = await getSettings();
  const nextRun = backup.getNextRunTime();
  res.json({
    ...state,
    destPath: settings.backup?.destPath ?? null,
    nextRun,
    defaultExcludes: backup.DEFAULT_EXCLUDES
  });
}));

// POST /api/backup/run
router.post('/run', asyncHandler(async (req, res) => {
  const settings = await getSettings();
  const destPath = settings.backup?.destPath;
  if (!destPath) {
    throw new ServerError('No backup destination configured in settings', { status: 400, code: 'BACKUP_NOT_CONFIGURED' });
  }
  const excludePaths = settings.backup?.excludePaths || [];
  const disabledDefaultExcludes = settings.backup?.disabledDefaultExcludes || [];
  const io = req.app.get('io');
  const result = await backup.runBackup(destPath, io, { excludePaths, disabledDefaultExcludes });
  res.json(result);
}));

// GET /api/backup/snapshots
router.get('/snapshots', asyncHandler(async (req, res) => {
  const settings = await getSettings();
  const snapshots = await backup.listSnapshots(settings.backup?.destPath);
  res.json(snapshots);
}));

function streamSnapshotDownload(res, stream, snapshotId) {
  const filename = `portos-snapshot-${snapshotId}.tar.gz`;
  res.setHeader('Content-Type', 'application/gzip');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  stream.on('error', (err) => {
    if (res.destroyed) return;
    console.error(`❌ Backup snapshot download failed for ${snapshotId}: ${err.message}`);
    if (res.headersSent) {
      res.destroy(err);
      return;
    }
    res.removeHeader('Content-Type');
    res.removeHeader('Content-Disposition');
    sendErrorResponse(res, new ServerError('Snapshot download failed', {
      status: 500,
      code: 'BACKUP_DOWNLOAD_FAILED',
    }));
  });
  res.once('close', () => {
    if (!res.writableEnded) stream.abort?.();
  });
  stream.pipe(res);
}

// GET /api/backup/snapshots/:snapshotId/download
router.get('/snapshots/:snapshotId/download', asyncHandler(async (req, res) => {
  const settings = await getSettings();
  const destPath = settings.backup?.destPath;
  if (!destPath) {
    throw new ServerError('No backup destination configured in settings', { status: 400, code: 'BACKUP_NOT_CONFIGURED' });
  }
  const stream = await backup.openSnapshotStream(destPath, req.params.snapshotId);
  streamSnapshotDownload(res, stream, req.params.snapshotId);
}));

// POST /api/backup/restore
router.post('/restore', asyncHandler(async (req, res) => {
  const { snapshotId, subdirFilter, dryRun } = validateRequest(restoreRequestSchema, req.body);
  const settings = await getSettings();
  const result = await backup.restoreSnapshot(settings.backup?.destPath, snapshotId, { dryRun, subdirFilter });
  res.json(result);
}));

// POST /api/backup/restore-db
router.post('/restore-db', asyncHandler(async (req, res) => {
  const { snapshotId, dryRun } = validateRequest(restoreDbRequestSchema, req.body);
  const settings = await getSettings();
  const destPath = settings.backup?.destPath;
  if (!destPath) {
    throw new ServerError('No backup destination configured in settings', { status: 400, code: 'BACKUP_NOT_CONFIGURED' });
  }
  const result = await backup.restorePostgres(destPath, snapshotId, { dryRun });
  res.json(result);
}));

export default router;
