import { sendErrorResponse } from './errorHandler.js';
import { onClientDisconnect } from './sseDownload.js';

/**
 * Pipe a readable to an Express response as a file attachment.
 *
 * Every attachment-download route needs the same teardown, and the error
 * handling is the whole reason this is shared rather than copied: the 'error'
 * event fires OUTSIDE the asyncHandler promise chain, so a throw there would
 * crash the process — it has to go through sendErrorResponse (shared envelope +
 * headers-sent guard). Pre-stream failures (the common case: the file vanished
 * after the readiness check) get the JSON error envelope; mid-stream failures
 * tear the socket down, since sendErrorResponse no-ops once headers are sent.
 *
 * Call sites: routes/imageTo3d.js (GLB + full-mesh), routes/backup.js
 * (snapshot tarball).
 *
 * @param {import('express').Response} res
 * @param {import('stream').Readable} stream - piped to res; may expose an
 *   `abort()` used to tear down an upstream child process on disconnect.
 * @param {object} opts
 * @param {string} opts.filename - offered to the browser as the download name.
 * @param {string} opts.contentType
 * @param {import('./errorHandler.js').ServerError} opts.failure - the error
 *   returned when the stream fails before any bytes are written.
 * @param {string} opts.label - short subject for the warning log.
 */
export function streamAttachment(res, stream, { filename, contentType, failure, label }) {
  res.set('Content-Type', contentType);
  res.set('Content-Disposition', `attachment; filename="${filename}"`);
  // Attachments are never meant to be sniffed into an executable type.
  res.set('X-Content-Type-Options', 'nosniff');

  stream.on('error', (err) => {
    if (res.destroyed) return; // our own abort, below — nothing left to report
    console.warn(`⚠️ ${label} stream error: ${err.code || err.message}`);
    if (res.headersSent) {
      res.destroy(err);
      return;
    }
    // Drop the download headers so the JSON error body isn't offered to the
    // browser as an attachment named like a real file.
    res.removeHeader('Content-Type');
    res.removeHeader('Content-Disposition');
    sendErrorResponse(res, failure);
  });

  onClientDisconnect(null, res, () => stream.abort?.());
  stream.pipe(res);
}
