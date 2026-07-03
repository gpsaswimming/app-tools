/**
 * @gpsa/swimparse — public entry point.
 *
 * Parse SDIF v3 (.sd3) or Hy-Tek (.hy3) meet results into one NormalizedMeet.
 * Zero dependencies; runs in the browser, Node, and CI.
 *
 *   import { parse, detectFormat } from '@gpsa/swimparse';
 *   const meet = parse(fileText, { filename: 'GG_at_WW.hy3' });
 */

import { parseSdif } from './sdif.js';
import { parseHy3 } from './hy3.js';
import { detectFormat } from './detect.js';

export { parseSdif } from './sdif.js';
export { parseHy3 } from './hy3.js';
export { detectFormat } from './detect.js';
export { score, GPSA_DUAL } from './score.js';
export * from './model.js';

/**
 * Parses meet-result text, auto-detecting the format unless one is given.
 *
 * @param {string} content
 * @param {Object} [opts]
 * @param {'sdif-v3'|'hy3'} [opts.format] force a format, skipping detection
 * @param {string} [opts.filename] used as a detection tie-breaker
 * @returns {import('./model.js').NormalizedMeet}
 */
export function parse(content, opts = {}) {
    const format = opts.format || detectFormat(content, opts.filename);
    if (format === 'sdif-v3') return parseSdif(content);
    if (format === 'hy3') return parseHy3(content);
    throw new Error('swimparse: could not detect meet-result format (expected SDIF .sd3 or Hy-Tek .hy3)');
}
