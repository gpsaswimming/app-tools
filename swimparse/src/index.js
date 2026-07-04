/**
 * @gpsa/swimparse — public entry point.
 *
 * Parse SDIF v3 (.sd3) or Hy-Tek (.hy3) meet results into one NormalizedMeet.
 * Zero dependencies; runs in the browser, Node, and CI.
 *
 *   import { parse, detectFormat, GPSA } from '@gpsa/swimparse';
 *   const meet = parse(fileText, { filename: 'GG_at_WW.hy3' });        // raw (keeps DOB)
 *   const meet = parse(fileText, { league: GPSA });               // DOB-free + age-groups
 */

import { parseSdif } from './sdif.js';
import { parseHy3 } from './hy3.js';
import { detectFormat } from './detect.js';
import { applyLeague } from './league.js';

export { parseSdif } from './sdif.js';
export { parseHy3 } from './hy3.js';
export { detectFormat } from './detect.js';
export { score, GPSA_DUAL, rulesetFromScoring } from './score.js';
export {
    GPSA,
    BUILTIN_LEAGUES,
    applyLeague,
    ageGroupLabel,
    ageOn,
    seasonReferenceDate,
} from './league.js';
export * from './model.js';

/**
 * Parses meet-result text, auto-detecting the format unless one is given.
 *
 * Pass `opts.league` to compute census age-groups and strip birthdates: the
 * result is DOB-free and stamped with the profile id (the parse boundary is the
 * PII firewall). Without a league the parse is the raw, lossless (DOB-bearing)
 * artifact — treat it as confidential.
 *
 * @param {string} content
 * @param {Object} [opts]
 * @param {'sdif-v3'|'hy3'} [opts.format] force a format, skipping detection
 * @param {string} [opts.filename] used as a detection tie-breaker
 * @param {import('./league.js').LeagueProfile} [opts.league] compute age-groups + drop DOB
 * @returns {import('./model.js').NormalizedMeet}
 */
export function parse(content, opts = {}) {
    const format = opts.format || detectFormat(content, opts.filename);
    let meet;
    if (format === 'sdif-v3') meet = parseSdif(content);
    else if (format === 'hy3') meet = parseHy3(content);
    else throw new Error('swimparse: could not detect meet-result format (expected SDIF .sd3 or Hy-Tek .hy3)');

    return opts.league ? applyLeague(meet, opts.league) : meet;
}
