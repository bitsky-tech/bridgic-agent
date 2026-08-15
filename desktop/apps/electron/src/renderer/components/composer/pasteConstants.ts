/**
 * Composer paste→mount tuning constants.
 *
 * Single source for paste-handling thresholds. Consumed by
 * `pasteClassify.ts`, which decides whether content stays inline or becomes a
 * Session-owned attachment.
 */

/** Plain-text pastes of at least this many characters become a `.txt`
 *  attachment (uploaded + mounted) instead of being inlined into the editor. */
export const LARGE_TEXT_THRESHOLD = 3000
