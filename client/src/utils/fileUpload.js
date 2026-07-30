/**
 * Shared file upload utilities
 * Used by DevTools Runner and CoS TasksTab for screenshot and attachment uploads
 */

import * as api from '../services/api';
import { formatBytes } from './formatters';

// Allowed attachment extensions (should match server)
export const ALLOWED_ATTACHMENT_EXTENSIONS = [
  '.txt', '.md', '.json', '.csv', '.xml', '.yaml', '.yml',
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg',
  '.pdf',
  '.js', '.ts', '.jsx', '.tsx', '.py', '.sh', '.sql', '.html', '.css',
  '.zip', '.tar', '.gz'
];

/**
 * `accept` value for attachment pickers.
 *
 * Extensions alone are not enough: iOS/iPadOS pickers only understand MIME
 * types and UTIs, so an extension-only `accept` greys out every file in the
 * Files app — the picker opens but nothing can be selected. Pairing the
 * extensions with the corresponding MIME types keeps desktop filtering precise
 * while leaving mobile pickers usable. `processAttachmentUploads` still
 * validates by extension, so a broader picker filter can't widen what uploads.
 */
export const ATTACHMENT_ACCEPT = [
  ...ALLOWED_ATTACHMENT_EXTENSIONS,
  'text/*',
  'image/*',
  'application/pdf',
  'application/json',
  'application/zip',
  'application/gzip',
  'application/x-tar'
].join(',');

/**
 * Largest raw file the server can accept. Every helper here POSTs its payload
 * base64-encoded inside a JSON body, so the express body limit is the real
 * ceiling — advertising anything larger just produces an opaque 413.
 *
 * Mirror of `MAX_BASE64_UPLOAD_BYTES` in `server/lib/uploadLimits.js`, which
 * owns the derivation and the rationale (the client can't import server
 * modules). Change it there first.
 */
export const JSON_UPLOAD_MAX_FILE_SIZE = 41 * 1024 * 1024;

/**
 * `accept` for the raster-image pickers (reference images, init images, LoRA
 * dataset uploads, sprite seeds, ImageClean). These are all fed to image-gen
 * backends that decode PNG/JPEG/WebP only — a broader `image/*` would let a
 * HEIC or SVG through to a confusing server-side failure.
 */
export const IMAGE_ACCEPT = 'image/png,image/jpeg,image/webp';

/**
 * Max screenshot size. Screenshots are pasted/dragged UI captures, so this sits
 * well below the wire limit by product choice, not by encoding math. Mirror of
 * `MAX_SCREENSHOT_BYTES` in `server/lib/uploadLimits.js`; `uploadLimits.test.js`
 * keeps the two in step.
 */
export const SCREENSHOT_MAX_FILE_SIZE = 10 * 1024 * 1024;

/**
 * Read a File as a base64 string (without the data URL prefix)
 * @param {File} file - File to read
 * @returns {Promise<string>} Base64-encoded file contents
 */
export function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      const commaIndex = result.indexOf(',');
      resolve(commaIndex !== -1 ? result.slice(commaIndex + 1) : result);
    };
    reader.onerror = () => reject(new Error(`Failed to read ${file.name}`));
    reader.readAsDataURL(file);
  });
}

/**
 * The image formats the upload endpoints can magic-byte verify — a mirror of
 * `detectImageFormat` in `server/lib/fileUtils.js`, which the client can't import.
 * Anything else is refused server-side with a 400, so the check has to exist here
 * too: a drag-drop or a clipboard paste bypasses the picker's `accept` entirely,
 * and without this an AVIF or SVG previews happily and only fails AFTER the user
 * has typed their message. `uploadLimits.test.js` guards the two lists against
 * drift.
 *
 * Distinct from `IMAGE_ACCEPT`, which is narrower on purpose (no GIF) because its
 * consumers feed image-gen backends rather than this upload pipeline.
 */
export const SUPPORTED_UPLOAD_IMAGE_MIME = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

const SUPPORTED_LABEL = 'PNG, JPEG, GIF, WebP';

/**
 * Gate a picked file as an uploadable image: a format the server accepts, within
 * the size cap.
 *
 * Every image picker in the app needs these checks, and a surface that PREVIEWS
 * before uploading (the Shell photo composer) can't get them from
 * `processScreenshotUploads`, which uploads immediately. So it lives here and both
 * call it, keeping one wording for the messages.
 *
 * @param {File} file
 * @param {number} [maxFileSize] - byte ceiling (default: the screenshot cap)
 * @returns {string|null} an error message, or null when the file is acceptable
 */
export function validateImageFile(file, maxFileSize = SCREENSHOT_MAX_FILE_SIZE) {
  if (!file?.type?.startsWith('image/')) return `File "${file?.name}" is not an image`;
  if (!SUPPORTED_UPLOAD_IMAGE_MIME.includes(file.type)) {
    return `File "${file.name}" is a ${file.type.replace('image/', '').toUpperCase()} — supported: ${SUPPORTED_LABEL}`;
  }
  if (file.size > maxFileSize) return `File "${file.name}" exceeds the ${formatBytes(maxFileSize)} limit`;
  return null;
}

/**
 * Process and upload image files as screenshots
 *
 * @param {FileList|File[]} files - Files to process
 * @param {Object} options - Upload options
 * @param {number} options.maxFileSize - Max file size in bytes (default: 10MB)
 * @param {Function} options.onSuccess - Callback for successful upload (receives uploaded file info)
 * @param {Function} options.onError - Callback for errors (receives error message)
 * @returns {Promise<void>}
 */
export async function processScreenshotUploads(files, options = {}) {
  const {
    maxFileSize = SCREENSHOT_MAX_FILE_SIZE,
    onSuccess,
    onError
  } = options;

  const fileArray = Array.from(files);

  for (const file of fileArray) {
    // Non-image files are skipped SILENTLY here (this runs over a multi-select /
    // drop of mixed content, where naming each non-image is noise) — but an
    // oversized image is reported, since the user clearly meant to upload it.
    if (!file.type.startsWith('image/')) continue;

    const problem = validateImageFile(file, maxFileSize);
    if (problem) {
      onError?.(problem);
      continue;
    }

    await uploadScreenshotFile(file, { onSuccess, onError });
  }
}

/**
 * Upload a single screenshot file
 *
 * @param {File} file - File to upload
 * @param {Object} options - Upload options
 * @param {Function} options.onSuccess - Callback for successful upload
 * @param {Function} options.onError - Callback for errors
 * @returns {Promise<Object|null>} Uploaded file info or null on failure
 */
export async function uploadScreenshotFile(file, options = {}) {
  const { onSuccess, onError } = options;

  return new Promise((resolve) => {
    const reader = new FileReader();

    reader.onload = async (ev) => {
      const result = ev?.target?.result;
      if (typeof result !== 'string') {
        onError?.('Failed to read file: unexpected result type');
        resolve(null);
        return;
      }

      const parts = result.split(',');
      if (parts.length < 2) {
        onError?.('Failed to read file: invalid data URL format');
        resolve(null);
        return;
      }

      const base64 = parts[1];
      const uploaded = await api.uploadScreenshot(base64, file.name, file.type).catch((err) => {
        onError?.(`Failed to upload: ${err.message}`);
        return null;
      });

      if (uploaded) {
        const fileInfo = {
          id: uploaded.id,
          filename: uploaded.filename,
          preview: result,
          path: uploaded.path
        };
        onSuccess?.(fileInfo);
        resolve(fileInfo);
      } else {
        resolve(null);
      }
    };

    reader.onerror = () => {
      onError?.('Failed to read file');
      resolve(null);
    };

    reader.readAsDataURL(file);
  });
}

// Max file size for attachments. Capped by the base64-in-JSON wire limit, not
// by any attachment-specific rule — see JSON_UPLOAD_MAX_FILE_SIZE.
export const ATTACHMENT_MAX_FILE_SIZE = JSON_UPLOAD_MAX_FILE_SIZE;

/**
 * Check if a file extension is allowed for attachments
 */
function isAllowedAttachmentExtension(filename) {
  const ext = filename.lastIndexOf('.') > -1
    ? filename.slice(filename.lastIndexOf('.')).toLowerCase()
    : '';
  return ALLOWED_ATTACHMENT_EXTENSIONS.includes(ext);
}

/**
 * Get file extension from filename
 */
function getFileExtension(filename) {
  const lastDot = filename.lastIndexOf('.');
  return lastDot > -1 ? filename.slice(lastDot).toLowerCase() : '';
}

/**
 * Check if a file is an image based on extension
 */
function isImageFile(filename) {
  const ext = getFileExtension(filename);
  return ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'].includes(ext);
}

/**
 * Process and upload generic file attachments
 *
 * @param {FileList|File[]} files - Files to process
 * @param {Object} options - Upload options
 * @param {number} options.maxFileSize - Max file size in bytes (default: ATTACHMENT_MAX_FILE_SIZE)
 * @param {Function} options.onSuccess - Callback for successful upload (receives uploaded file info)
 * @param {Function} options.onError - Callback for errors (receives error message)
 * @returns {Promise<void>}
 */
export async function processAttachmentUploads(files, options = {}) {
  const {
    maxFileSize = ATTACHMENT_MAX_FILE_SIZE,
    onSuccess,
    onError
  } = options;

  const fileArray = Array.from(files);

  for (const file of fileArray) {
    // Check file extension is allowed
    if (!isAllowedAttachmentExtension(file.name)) {
      const allowedList = ALLOWED_ATTACHMENT_EXTENSIONS.join(', ');
      onError?.(`File "${file.name}" has unsupported type. Allowed: ${allowedList}`);
      continue;
    }

    // Check file size
    if (file.size > maxFileSize) {
      onError?.(`File "${file.name}" exceeds the ${formatBytes(maxFileSize)} limit`);
      continue;
    }

    await uploadAttachmentFile(file, { onSuccess, onError });
  }
}

/**
 * Upload a single attachment file
 *
 * @param {File} file - File to upload
 * @param {Object} options - Upload options
 * @param {Function} options.onSuccess - Callback for successful upload
 * @param {Function} options.onError - Callback for errors
 * @returns {Promise<Object|null>} Uploaded file info or null on failure
 */
export async function uploadAttachmentFile(file, options = {}) {
  const { onSuccess, onError } = options;

  return new Promise((resolve) => {
    const reader = new FileReader();

    reader.onload = async (ev) => {
      const result = ev?.target?.result;
      if (typeof result !== 'string') {
        onError?.('Failed to read file: unexpected result type');
        resolve(null);
        return;
      }

      const parts = result.split(',');
      if (parts.length < 2) {
        onError?.('Failed to read file: invalid data URL format');
        resolve(null);
        return;
      }

      const base64 = parts[1];
      const uploaded = await api.uploadAttachment(base64, file.name).catch((err) => {
        onError?.(`Failed to upload: ${err.message}`);
        return null;
      });

      if (uploaded) {
        const fileInfo = {
          id: uploaded.id,
          filename: uploaded.filename,
          originalName: uploaded.originalName || file.name,
          path: uploaded.path,
          size: uploaded.size,
          mimeType: uploaded.mimeType,
          // For images, create preview from the data URL
          preview: isImageFile(file.name) ? result : null,
          isImage: isImageFile(file.name)
        };
        onSuccess?.(fileInfo);
        resolve(fileInfo);
      } else {
        resolve(null);
      }
    };

    reader.onerror = () => {
      onError?.('Failed to read file');
      resolve(null);
    };

    reader.readAsDataURL(file);
  });
}
