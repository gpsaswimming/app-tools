/**
 * League profiles — the config contract for age-grouping and scoring.
 *
 * A league profile is a plain object (NOT YAML) so swimparse stays zero-dep and
 * runs in the browser. It carries three things a swim league defines for itself:
 *
 *   ageUp     — the reference date age is figured "as of" (GPSA: June 1st)
 *   ageGroups — the labelled bands a swimmer's age falls into
 *   scoring   — the point values placings earn (structural rules stay in the
 *               engine as policy; only the *constants* are config — see score.js)
 *
 * The profile is passed INTO the parser. When present, swimparse computes each
 * swimmer's census age-group from their birthdate and then **drops the birthdate
 * from the output** — the parse boundary becomes the PII firewall, and a
 * NormalizedMeet parsed with a league is no longer a confidential artifact.
 *
 * The profile is season-stable — a summer league's age-up date, age bands, and
 * scoring stay fixed year to year — so it carries no season and needs no per-year
 * edits. `GPSA` here is the single source of truth; `leagues/gpsa.json` is a
 * portable mirror (for app-census's YAML and the CLI's `--league-file`) kept equal
 * by a test. When app-census exists it will own the canonical, human-editable
 * copy; this stays as swimparse's built-in default.
 *
 * @typedef {Object} LeagueProfile
 * @property {string} id                         Provenance stamp, e.g. "gpsa".
 * @property {{reference: string}} ageUp         "MM-DD" (age as of that date in the
 *                                               meet's season year) or "meet-date".
 * @property {AgeGroupBand[]} ageGroups          Ordered bands; first match wins.
 * @property {ScoringProfile} scoring
 *
 * @typedef {Object} AgeGroupBand
 * @property {string} label                      e.g. "9-10".
 * @property {number} [min]                      Inclusive lower bound (default 0).
 * @property {number} [max]                      Inclusive upper bound (default ∞).
 *
 * @typedef {Object} ScoringProfile
 * @property {number[]} individualPlaces         Points by place, index 0 = 1st.
 * @property {number[]} relayPlaces              Points by place for scoring relays.
 * @property {number} [entriesScoredPerTeam]     League cap; documented, not enforced
 *                                               here (source files are already
 *                                               capped — see score.js).
 */

/**
 * The GPSA league profile. Single source of truth for the built-in.
 *
 * Season-stable: the age-up date, age bands, and scoring don't change year to
 * year, so the profile carries no season — `ageUp.reference` is a bare month-day
 * anchored to each meet's own season year at compute time. If a rule ever does
 * change, bump `id` semantically (e.g. "gpsa-v2"), not by calendar year.
 */
export const GPSA = {
    id: 'gpsa',
    ageUp: { reference: '06-01' }, // age as of June 1 of the meet's season year
    ageGroups: [
        { label: '6&U', max: 6 },
        { label: '7-8', min: 7, max: 8 },
        { label: '9-10', min: 9, max: 10 },
        { label: '11-12', min: 11, max: 12 },
        { label: '13-14', min: 13, max: 14 },
        { label: '15-18', min: 15, max: 18 },
    ],
    scoring: {
        individualPlaces: [5, 3, 1], // 1st/2nd/3rd; 4th+ = 0
        relayPlaces: [7], // winner only
        entriesScoredPerTeam: 2,
    },
};

/** Built-in profiles selectable by name (CLI `--league <name>`). */
export const BUILTIN_LEAGUES = { gpsa: GPSA };

/**
 * Resolves the reference date age is figured against for a meet.
 * @param {string|null} meetDate ISO "YYYY-MM-DD" (meet start) or null.
 * @param {LeagueProfile} profile
 * @returns {string|null} ISO reference date, or null if it can't be determined.
 */
export function seasonReferenceDate(meetDate, profile) {
    const ref = profile?.ageUp?.reference;
    if (!ref || !meetDate) return null;
    if (ref === 'meet-date') return meetDate;
    // "MM-DD" anchored to the meet's season (calendar) year.
    return `${meetDate.slice(0, 4)}-${ref}`;
}

/**
 * Whole years old on `refDate` for someone born on `birthDate` (both ISO).
 * @param {string} birthDate
 * @param {string} refDate
 * @returns {number|null}
 */
export function ageOn(birthDate, refDate) {
    if (!birthDate || !refDate) return null;
    const [by, bm, bd] = birthDate.split('-').map(Number);
    const [ry, rm, rd] = refDate.split('-').map(Number);
    if ([by, bm, bd, ry, rm, rd].some(Number.isNaN)) return null;
    let age = ry - by;
    if (rm < bm || (rm === bm && rd < bd)) age--;
    return age;
}

/**
 * Census age-group label for a swimmer, from DOB + the league's age-up rule.
 * Independent of which event they swam (captures swim-ups correctly).
 * @param {string|null} birthDate ISO, or null.
 * @param {string|null} meetDate  ISO meet start, or null.
 * @param {LeagueProfile} profile
 * @returns {string|null} the band label, or null if it can't be resolved.
 */
export function ageGroupLabel(birthDate, meetDate, profile) {
    const refDate = seasonReferenceDate(meetDate, profile);
    const age = ageOn(birthDate, refDate);
    if (age == null) return null;
    for (const band of profile.ageGroups) {
        const min = band.min ?? 0;
        const max = band.max ?? Infinity;
        if (age >= min && age <= max) return band.label;
    }
    return null;
}

/**
 * Applies a league profile to a freshly-parsed NormalizedMeet, in place:
 *   1. computes each swimmer's census `ageGroup` from their birthdate,
 *   2. **re-keys swimmer ids** off DOB (the raw id is `name|birthDate`) onto a
 *      DOB-free `name|ageGroup` key, remapping every `swimmerId` reference,
 *   3. **strips birthDate / usasId** from swimmers and results,
 *   4. stamps `meet.ageProfile` for provenance.
 *
 * Steps 2–3 are the PII firewall: after this the meet carries no birthdate,
 * including inside identity keys, and is no longer a confidential artifact.
 *
 * The `name|ageGroup` key is a per-meet identity, not a cross-season one — two
 * same-named teammates in the same age band would collide, and a swimmer's key
 * changes as they age up. Durable cross-season athlete identity is assigned later
 * by the ingest/DB layer (app-census), not here.
 *
 * @param {import('./model.js').NormalizedMeet} meet
 * @param {LeagueProfile} profile
 * @returns {import('./model.js').NormalizedMeet}
 */
export function applyLeague(meet, profile) {
    const meetDate = meet.meet?.startDate ?? null;
    const remap = new Map(); // raw DOB-based id → DOB-free id

    for (const s of meet.swimmers) {
        s.ageGroup = ageGroupLabel(s.birthDate, meetDate, profile);
        const newId = `${s.lastName}|${s.firstName}|${s.ageGroup || ''}`.toLowerCase();
        remap.set(s.id, newId);
        s.id = newId;
        delete s.birthDate;
        delete s.usasId;
    }
    for (const ev of meet.events) {
        for (const r of ev.results) {
            delete r.birthDate;
            if (r.swimmerId) r.swimmerId = remap.get(r.swimmerId) ?? r.swimmerId;
            if (r.legs) {
                for (const leg of r.legs) {
                    if (leg.swimmerId) leg.swimmerId = remap.get(leg.swimmerId) ?? leg.swimmerId;
                }
            }
        }
    }
    meet.ageProfile = profile.id;
    return meet;
}
