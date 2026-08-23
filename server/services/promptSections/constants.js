/**
 * Prompt-section constants shared by the full and light orchestrators.
 */

import { PROVIDER_TYPES } from '../../lib/aiToolkit/constants.js';

export const LIGHT_CONTEXT_PROVIDER_TYPES = new Set([PROVIDER_TYPES.TUI, PROVIDER_TYPES.CLI]);

export const SIMPLIFY_INLINE_REVIEW = 'review your changed code for reuse, quality, and efficiency (DRY, dead code, naming, simpler equivalents, missed edge cases)';

export const INLINE_REVIEW_LOOP_STEP = 4;
