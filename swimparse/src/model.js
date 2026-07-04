/**
 * The NormalizedMeet contract.
 *
 * This is the single shape that every GPSA tool consumes. Both the SDIF and
 * HY3 adapters produce it; the publicity HTML generator, the results archive,
 * and the census importer all read it (never raw fixed-width text).
 *
 * Design rule: **lossless superset**. Capture every swim — placing or not,
 * exhibition, DQ, no-show — plus birthdates, seed times, splits and DQ
 * reasons. Consumers filter down to what they need (e.g. publicity keeps only
 * place === 1; census keeps everything). Never drop data at parse time.
 *
 * PRIVACY: `swimmers[].birthDate` and `usasId` are PII for minors. A
 * NormalizedMeet with these populated is a confidential artifact — see the
 * fixture-sanitization guardrail before committing one to a public repo.
 * Parsing WITH a league profile (see league.js) computes each swimmer's
 * `ageGroup`, strips birthDate/usasId, and stamps `ageProfile` — that output is
 * DOB-free and no longer confidential.
 */

/**
 * @typedef {import('./times.js').SwimTime} SwimTime
 */

/**
 * @typedef {Object} NormalizedMeet
 * @property {'sdif-v3'|'hy3'} format         Source format the file was parsed from.
 * @property {Object} source                  Producing software (A0/A1 record).
 * @property {string} [source.software]
 * @property {string} [source.version]
 * @property {string} [source.createdAt]      ISO date if available.
 * @property {MeetInfo} meet
 * @property {Team[]} teams
 * @property {Swimmer[]} swimmers             Deduped registry (name + birthdate).
 * @property {Event[]} events
 * @property {string} [ageProfile]            League profile id used to age-group +
 *                                            strip DOB (present only when parsed
 *                                            with a league, e.g. "gpsa").
 */

/**
 * @typedef {Object} MeetInfo
 * @property {string} name                    Display name (may be improved for dual meets).
 * @property {string} rawName                 Name exactly as it appeared in the file.
 * @property {string} [hostName]
 * @property {string|null} startDate          ISO "YYYY-MM-DD".
 * @property {string|null} [endDate]
 * @property {string|null} [course]           'SCY' | 'LCM' | 'SCM'.
 */

/**
 * @typedef {Object} Team
 * @property {string} code                    Display code, VA-prefix stripped (e.g. "WW").
 * @property {string} fullCode                Raw code as in the file (e.g. "VAWW").
 * @property {string} name
 * @property {string} [shortName]
 */

/**
 * @typedef {Object} Swimmer
 * @property {string} id                      Stable within-file id.
 * @property {string} teamCode
 * @property {string} lastName
 * @property {string} firstName
 * @property {string} [preferredName]
 * @property {string} [middleInitial]
 * @property {string} fullName                "Last, First".
 * @property {'M'|'F'} [gender]
 * @property {string|null} [birthDate]        ISO, or null. PII. Omitted when
 *                                            parsed with a league profile.
 * @property {string|null} [usasId]           PII. Omitted when parsed with a league.
 * @property {number|null} [age]
 * @property {string|null} [ageGroup]         Census age-group label (e.g. "9-10"),
 *                                            computed from DOB + league profile.
 *                                            Present only when parsed with a league.
 */

/**
 * @typedef {Object} Event
 * @property {string} number                  Event number as a string (may be alphanumeric).
 * @property {'individual'|'relay'} type
 * @property {'M'|'F'|'X'} gender
 * @property {number} distance
 * @property {string} stroke                  Canonical stroke name.
 * @property {string|null} [course]
 * @property {{label:string, lower:number, upper:number}} ageGroup
 * @property {string} description             Human label, e.g. "Boys 15-18 100m IM".
 * @property {(IndividualResult|RelayResult)[]} results
 */

/**
 * @typedef {Object} IndividualResult
 * @property {'individual'} kind
 * @property {string} [swimmerId]             Links to Swimmer.id when resolvable.
 * @property {string} swimmerName             "Last, First" as in the file.
 * @property {string} teamCode
 * @property {string|null} [birthDate]        ISO. PII. Omitted when parsed with a
 *                                            league (join to Swimmer for ageGroup).
 * @property {SwimTime|null} seedTime
 * @property {SwimTime|null} finalTime        The time swum. NOTE: for HY3 this is
 *                                            retained even on a DQ; for SDIF it is
 *                                            null on DQ/NS (the format nulls it).
 * @property {import('./constants.js').ResultStatus} status
 * @property {boolean} disqualified
 * @property {string} [dqCode]                HY3 only.
 * @property {string} [dqReason]              HY3 H1/H2 only.
 * @property {number|null} place              null = non-scoring / exhibition.
 * @property {number} [heat]
 * @property {number} [lane]
 * @property {number} points
 * @property {number[]} [splits]              Cumulative split seconds (HY3 G1).
 */

/**
 * @typedef {Object} RelayResult
 * @property {'relay'} kind
 * @property {string} teamCode
 * @property {string} relayLetter             'A', 'B', ...
 * @property {SwimTime|null} seedTime
 * @property {SwimTime|null} finalTime
 * @property {import('./constants.js').ResultStatus} status
 * @property {boolean} disqualified
 * @property {string} [dqCode]
 * @property {string} [dqReason]
 * @property {number|null} place
 * @property {number} [heat]
 * @property {number} [lane]
 * @property {number} points
 * @property {RelayLeg[]} legs
 * @property {number[]} [splits]
 */

/**
 * @typedef {Object} RelayLeg
 * @property {string} [swimmerId]
 * @property {string} name
 * @property {'M'|'F'} [gender]
 * @property {number} [age]
 * @property {number} legOrder                1-4 (or higher for alternates).
 */

/**
 * Strips the SDIF/HY3 state prefix ("VA") from a raw team code for display.
 * @param {string} rawCode
 * @returns {string}
 */
export function displayTeamCode(rawCode) {
    const c = (rawCode || '').trim();
    return c.startsWith('VA') ? c.slice(2) : c;
}

/**
 * Improves a dual-meet name to "YYYY Host v. Away" when the shape allows it.
 * Mutates and returns `meet`.
 * @param {MeetInfo} meet
 * @param {Team[]} teams
 * @returns {MeetInfo}
 */
export function improveMeetName(meet, teams) {
    if (meet.hostName && meet.startDate && teams.length === 2) {
        const year = meet.startDate.slice(0, 4);
        const away = teams.find((t) => t.name !== meet.hostName);
        if (away) meet.name = `${year} ${meet.hostName} v. ${away.name}`;
    }
    return meet;
}

/**
 * Builds the deduped swimmer registry from individual results.
 * Keyed on `lastName|firstName|birthDate` — matches the census identity rule
 * (middle name excluded because it drifts between meets).
 *
 * @param {Event[]} events
 * @param {Map<string, Partial<Swimmer>>} [enrich] optional id→extra fields (D3/D1 data)
 * @returns {Swimmer[]}
 */
export function deriveSwimmers(events, enrich) {
    /** @type {Map<string, Swimmer>} */
    const byKey = new Map();
    for (const ev of events) {
        if (ev.type !== 'individual') continue;
        const gender = ev.gender === 'X' ? undefined : ev.gender;
        for (const r of ev.results) {
            const [last, first] = splitName(r.swimmerName);
            const key = `${last}|${first}|${r.birthDate || ''}`.toLowerCase();
            if (!byKey.has(key)) {
                byKey.set(key, {
                    id: key,
                    teamCode: r.teamCode,
                    lastName: last,
                    firstName: first,
                    fullName: r.swimmerName,
                    gender,
                    birthDate: r.birthDate || null,
                    usasId: null,
                });
            }
            r.swimmerId = key;
        }
    }
    if (enrich) {
        for (const s of byKey.values()) {
            const extra = enrich.get(s.id);
            if (extra) Object.assign(s, extra);
        }
    }
    return [...byKey.values()];
}

/**
 * Splits "Last, First M" into ["Last", "First"] (middle dropped).
 * @param {string} name
 * @returns {[string, string]}
 */
export function splitName(name) {
    const parts = String(name || '').split(',');
    const last = (parts[0] || '').trim();
    const first = (parts[1] || '').trim().split(/\s+/)[0] || '';
    return [last, first];
}
