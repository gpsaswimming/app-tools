/**
 * GPSA Invitational Entry Summary — core logic.
 *
 * Turns a team's SDIF (.sd3) meet-entry file into the billable counts and fee
 * total for a GPSA invitational (Summer Splash or City Meet).
 *
 * Used by:
 * - entry-summary.html (browser)
 *
 * Parsing is delegated to @gpsa/swimparse (../swimparse/src/index.js). Passing
 * the GPSA league strips birthdates at the parse boundary, so nothing that
 * leaves this module carries PII. This is the first web production consumer of
 * swimparse — the billable contract it relies on is deliberately tiny:
 *   individual entries = D0 record count
 *   relay entries      = E0 record count
 *   swimmers           = distinct swimmers across individual entries AND relay
 *                        legs (so relay-only swimmers are still surcharged)
 * entry-summary-core.test.js locks that contract against a synthetic fixture.
 */

import { parse, GPSA } from '../swimparse/src/index.js';

// Version of the entry-fee billing logic (counts → fees, and the seeding vs
// post-meet comparison). Stamped onto the treasurer's report + CSV so a figure
// can always be traced to the method that produced it. Bump on any change that
// alters a computed fee. 1.0 = per-swimmer comparison billing.
export const VERSION = '1.0';

// =============================================================================
// Fee schedules — baked at build time. One config per invitational.
// A season change (rates or the City Meet payment deadline) is a one-line edit.
// =============================================================================

export const MEETS = {
    'summer-splash': {
        label: 'Summer Splash',
        swimmerSurcharge: 5,
        individualEntry: 5,
        relayEntry: 0, // relays are built from the pool by the meet director — not team-submitted
        notes: [
            'Meet fees will be collected at City Meet.',
            'There will be no refunds (surcharge and/or entry fees) if the meet or part of the meet must be canceled due to inclement weather or unforeseen problems.',
        ],
    },
    'city-meet': {
        label: 'City Meet',
        swimmerSurcharge: 6,
        individualEntry: 5,
        relayEntry: 20,
        notes: [
            'Checks should be made payable to: Greater Peninsula Swimming Association.',
            'Each team shall submit only one check per team.',
            'Payment must be received on-deck by 9:00 am August 1, 2026.',
            'There will be no refunds (surcharge and/or entry fees) if the meet or part of the meet must be canceled due to inclement weather or unforeseen problems.',
        ],
    },
};

// =============================================================================
// Parsing → billable counts
// =============================================================================

/**
 * Parses a team's SDIF entry file into the billable counts for the summary.
 * Never returns PII — swimparse's GPSA-league mode strips birthdates.
 *
 * @param {string} fileText - raw .sd3 contents
 * @param {{ filename?: string }} [opts]
 * @returns {{
 *   teams: Array<{code: string, name: string}>,
 *   swimmers: number,
 *   swimmerNames: string[],
 *   individualEntries: number,
 *   relayEntries: number,
 *   relayOnlySwimmers: number,
 * }}
 */
export function summarizeEntries(fileText, { filename } = {}) {
    const meet = parse(fileText, { league: GPSA, filename });

    let individualEntries = 0;
    let relayEntries = 0;
    const indivSwimmers = new Set();
    const relaySwimmers = new Set();

    for (const ev of meet.events ?? []) {
        for (const r of ev.results ?? []) {
            if (r.kind === 'individual') {
                individualEntries++;
                if (r.swimmerName) indivSwimmers.add(r.swimmerName.trim());
            } else if (r.kind === 'relay') {
                relayEntries++;
                for (const leg of r.legs ?? []) {
                    if (leg.name) relaySwimmers.add(leg.name.trim());
                }
            }
        }
    }

    // Swimmer surcharge is per swimmer, including relay-only swimmers (City Meet
    // requires relay legs populated at submittal, so they are nameable there).
    const allSwimmers = new Set([...indivSwimmers, ...relaySwimmers]);
    const relayOnly = [...relaySwimmers].filter((n) => !indivSwimmers.has(n));

    const teams = (meet.teams ?? []).map((t) => ({ code: t.code, name: t.name || t.code }));

    return {
        teams,
        swimmers: allSwimmers.size,
        swimmerNames: [...allSwimmers].sort((a, b) => a.localeCompare(b)),
        individualEntries,
        relayEntries,
        relayOnlySwimmers: relayOnly.length,
    };
}

/**
 * Parses a MERGED meet file (all teams — the league's Hy-Tek .hy3, or a merged
 * .sd3) into per-team billable counts, for the treasurer's fee report. Same
 * DOB-free contract as summarizeEntries; swimmers are deduped within each team,
 * so relay-only swimmers are still counted for that team's surcharge.
 *
 * @param {string} fileText
 * @param {{ filename?: string }} [opts]
 * @returns {Array<{
 *   teamCode: string, teamName: string, swimmers: number,
 *   individualEntries: number, relayEntries: number, relayOnlySwimmers: number,
 * }>} one row per team, sorted by team name
 */
export function summarizeByTeam(fileText, { filename } = {}) {
    const meet = parse(fileText, { league: GPSA, filename });
    const nameByCode = new Map((meet.teams ?? []).map((t) => [t.code, t.name || t.code]));

    const acc = new Map(); // code -> { indiv, relays, indivSwimmers:Set, relaySwimmers:Set }
    for (const ev of meet.events ?? []) {
        for (const r of ev.results ?? []) {
            const code = r.teamCode || '??';
            let rec = acc.get(code);
            if (!rec) { rec = { indiv: 0, relays: 0, indivSwimmers: new Set(), relaySwimmers: new Set() }; acc.set(code, rec); }
            if (r.kind === 'individual') {
                rec.indiv++;
                if (r.swimmerName) rec.indivSwimmers.add(r.swimmerName.trim());
            } else if (r.kind === 'relay') {
                rec.relays++;
                for (const leg of r.legs ?? []) {
                    if (leg.name) rec.relaySwimmers.add(leg.name.trim());
                }
            }
        }
    }

    return [...acc.entries()]
        .map(([code, rec]) => ({
            teamCode: code,
            teamName: nameByCode.get(code) || code,
            swimmers: new Set([...rec.indivSwimmers, ...rec.relaySwimmers]).size,
            individualEntries: rec.indiv,
            relayEntries: rec.relays,
            relayOnlySwimmers: [...rec.relaySwimmers].filter((n) => !rec.indivSwimmers.has(n)).length,
        }))
        .sort((a, b) => a.teamName.localeCompare(b.teamName));
}

/**
 * Stable identity for an event across two exports of the same meet. Prefers the
 * event number; falls back to its defining attributes if a file omits it.
 * @param {import('../swimparse/src/model.js').Event} ev
 */
function eventKey(ev) {
    return ev.number || `${ev.gender}|${ev.distance}|${ev.stroke}|${ev.ageGroup?.label ?? ''}`;
}

/**
 * Collects each team's billable entities from one file, indexed so that an
 * initial seeding and the post-meet results can be compared per swimmer (not
 * just per aggregate count). Same DOB-free contract as summarizeByTeam.
 *   swimmers        — every name (individual entrants + relay legs), for the surcharge
 *   eventsBySwimmer — name → set of that swimmer's individual event keys
 *   relays          — set of `${event}|${relayLetter}` team relay entries
 *
 * @param {string} fileText
 * @param {{ filename?: string }} [opts]
 * @returns {Map<string, {teamCode: string, teamName: string,
 *   swimmers: Set<string>, eventsBySwimmer: Map<string, Set<string>>, relays: Set<string>}>}
 *   keyed by team code
 */
export function collectBillables(fileText, { filename } = {}) {
    const meet = parse(fileText, { league: GPSA, filename });
    const nameByCode = new Map((meet.teams ?? []).map((t) => [t.code, t.name || t.code]));

    const acc = new Map();
    for (const ev of meet.events ?? []) {
        const evKey = eventKey(ev);
        // Reconciliation labels cite the event number — that's how a team rep
        // reads the heat sheet, and it keeps same-named events distinguishable.
        const evLabel = ev.number ? `#${ev.number} ${ev.description || ''}`.trim() : (ev.description || evKey);
        for (const r of ev.results ?? []) {
            const code = r.teamCode || '??';
            let rec = acc.get(code);
            if (!rec) {
                rec = { teamCode: code, teamName: nameByCode.get(code) || code, swimmers: new Set(), eventsBySwimmer: new Map(), relays: new Set(), labels: new Map() };
                acc.set(code, rec);
            }
            if (r.kind === 'individual') {
                const name = (r.swimmerName || '').trim();
                if (name) {
                    rec.swimmers.add(name);
                    let evs = rec.eventsBySwimmer.get(name);
                    if (!evs) { evs = new Set(); rec.eventsBySwimmer.set(name, evs); }
                    evs.add(evKey);
                    rec.labels.set(evKey, evLabel);
                }
            } else if (r.kind === 'relay') {
                const relayKey = `${evKey}|${r.relayLetter || ''}`;
                rec.relays.add(relayKey);
                rec.labels.set(relayKey, `${evLabel}${r.relayLetter ? ` — Relay ${r.relayLetter}` : ''}`);
                for (const leg of r.legs ?? []) {
                    if (leg.name) rec.swimmers.add(leg.name.trim());
                }
            }
        }
    }
    return acc;
}

/**
 * Compares an initial-seeding collection with a post-meet collection into
 * per-team seeded / added / billable counts, for the two-file comparison.
 *
 * Policy:
 *   Swimmers (surcharge) — union of names: every new swimmer is charged, and a
 *     scratched swimmer is never refunded (billable = |seeded ∪ final|).
 *   Individual events — compared PER SWIMMER, then summed:
 *     billable = Σ max(seededₙ, finalₙ),  added = Σ max(0, finalₙ − seededₙ).
 *     A new swimmer bills all their events as added; a scratched swimmer's events
 *     are kept, not reduced; and a swimmer who moves their OWN entry from one
 *     event to another is a wash (their per-swimmer count is unchanged), so they
 *     aren't charged twice. Crucially, different swimmers never net against each
 *     other — one swimmer's scratch can't cancel another's addition.
 *   Relays — union of `${event}|${relayLetter}` team relay entries.
 *
 * @param {ReturnType<typeof collectBillables>} seeded  from the seeding file
 * @param {ReturnType<typeof collectBillables>} final   from the post-meet file
 * `detail` is the reconciliation addendum: the named swimmers and events behind
 * the counts, derived from the SAME per-swimmer arithmetic that sets the charge,
 * so the backup can never contradict the invoice. Only swimmers whose entries
 * moved appear; `status` explains the charge ('swapped' and 'reduced' are the
 * cases where entries changed but the bill did not).
 *
 * @returns {Array<{teamCode: string, teamName: string,
 *   seeded: {swimmers: number, individualEntries: number, relayEntries: number},
 *   added: {swimmers: number, individualEntries: number, relayEntries: number},
 *   billable: {swimmers: number, individualEntries: number, relayEntries: number},
 *   detail: {swimmers: Array<{name: string, seededEvents: string[], finalEvents: string[],
 *     gainedEvents: string[], droppedEvents: string[], seededCount: number, finalCount: number,
 *     charged: number, addedCharged: number,
 *     status: 'new'|'scratched'|'added'|'reduced'|'swapped'}>,
 *     newSwimmers: string[], addedRelays: string[]}}>}
 *   one row per team seen in either file, sorted by team name
 */
export function compareBillables(seeded, final) {
    const emptySet = new Set();
    const emptyMap = new Map();
    const codes = new Set([...seeded.keys(), ...final.keys()]);
    const rows = [];
    for (const code of codes) {
        const s = seeded.get(code);
        const f = final.get(code);
        const teamName = s?.teamName || f?.teamName || code;

        // Swimmers (surcharge): union of names.
        const sSw = s?.swimmers ?? emptySet;
        const fSw = f?.swimmers ?? emptySet;
        const swSeeded = sSw.size;
        const swAdded = [...fSw].filter((n) => !sSw.has(n)).length;
        const swBillable = new Set([...sSw, ...fSw]).size;

        // Individual events: max per swimmer, summed — so scratches never reduce,
        // additions are charged, and a same-swimmer event swap is a wash.
        const sEv = s?.eventsBySwimmer ?? emptyMap;
        const fEv = f?.eventsBySwimmer ?? emptyMap;
        const names = new Set([...sEv.keys(), ...fEv.keys()]);
        // Labels for the addendum; the two files may each know only some events.
        const labels = new Map([...(s?.labels ?? emptyMap), ...(f?.labels ?? emptyMap)]);
        const label = (k) => labels.get(k) || k;
        let indSeeded = 0, indAdded = 0, indBillable = 0;
        const swimmerDetail = [];
        for (const n of names) {
            const sSet = sEv.get(n) ?? emptySet;
            const fSet = fEv.get(n) ?? emptySet;
            const sc = sSet.size;
            const fc = fSet.size;
            indSeeded += sc;
            indAdded += Math.max(0, fc - sc);
            indBillable += Math.max(sc, fc);

            // Addendum row — only for swimmers whose entries actually moved.
            const gained = [...fSet].filter((k) => !sSet.has(k));
            const dropped = [...sSet].filter((k) => !fSet.has(k));
            if (!gained.length && !dropped.length) continue;
            swimmerDetail.push({
                name: n,
                seededEvents: [...sSet].map(label).sort(),
                finalEvents: [...fSet].map(label).sort(),
                gainedEvents: gained.map(label).sort(),
                droppedEvents: dropped.map(label).sort(),
                seededCount: sc,
                finalCount: fc,
                charged: Math.max(sc, fc),
                addedCharged: Math.max(0, fc - sc),
                // Why the charge is what it is — drives the addendum's note column.
                status: sc === 0 ? 'new'
                    : fc === 0 ? 'scratched'
                    : fc > sc ? 'added'
                    : fc < sc ? 'reduced'
                    : 'swapped',
            });
        }
        // A new swimmer who only swam a relay leg still owes the surcharge but has
        // no individual events, so the loop above never saw them. Without this the
        // addendum's per-swimmer money would not foot to the invoice.
        const newSwimmers = [...fSw].filter((n) => !sSw.has(n)).sort();
        const listed = new Set(swimmerDetail.map((d) => d.name));
        for (const n of newSwimmers) {
            if (listed.has(n)) continue;
            swimmerDetail.push({
                name: n,
                seededEvents: [], finalEvents: [], gainedEvents: [], droppedEvents: [],
                seededCount: 0, finalCount: 0, charged: 0, addedCharged: 0,
                status: 'new', relayOnly: true,
            });
        }
        swimmerDetail.sort((a, b) => a.name.localeCompare(b.name));

        // Relays: union of team relay entries.
        const sR = s?.relays ?? emptySet;
        const fR = f?.relays ?? emptySet;
        const relSeeded = sR.size;
        const addedRelays = [...fR].filter((x) => !sR.has(x));
        const relAdded = addedRelays.length;
        const relBillable = new Set([...sR, ...fR]).size;

        rows.push({
            teamCode: code,
            teamName,
            seeded: { swimmers: swSeeded, individualEntries: indSeeded, relayEntries: relSeeded },
            added: { swimmers: swAdded, individualEntries: indAdded, relayEntries: relAdded },
            billable: { swimmers: swBillable, individualEntries: indBillable, relayEntries: relBillable },
            detail: {
                swimmers: swimmerDetail,
                newSwimmers,
                addedRelays: addedRelays.map(label).sort(),
            },
        });
    }
    return rows.sort((a, b) => a.teamName.localeCompare(b.teamName));
}

// =============================================================================
// Counts → fees
// =============================================================================

/**
 * Computes the itemized fee schedule for a set of counts against a meet.
 *
 * @param {{ swimmers: number, individualEntries: number, relayEntries: number }} counts
 * @param {keyof typeof MEETS} meetKey
 * @returns {{
 *   meet: string,
 *   lines: Array<{ label: string, qty: number, rate: number, amount: number }>,
 *   total: number,
 *   notes: string[],
 * }}
 */
export function computeFees(counts, meetKey) {
    const m = MEETS[meetKey];
    if (!m) throw new Error(`Unknown meet: ${meetKey}`);

    const swimmers = Number(counts.swimmers) || 0;
    const individualEntries = Number(counts.individualEntries) || 0;
    const relayEntries = Number(counts.relayEntries) || 0;

    const lines = [
        { label: 'Swimmer surcharge', qty: swimmers, rate: m.swimmerSurcharge, amount: swimmers * m.swimmerSurcharge },
        { label: 'Individual events', qty: individualEntries, rate: m.individualEntry, amount: individualEntries * m.individualEntry },
        { label: 'Relay events', qty: relayEntries, rate: m.relayEntry, amount: relayEntries * m.relayEntry },
    ];
    const total = lines.reduce((s, l) => s + l.amount, 0);

    return { meet: m.label, lines, total, notes: m.notes };
}

/** Formats a dollar amount as US currency, e.g. 415 -> "$415.00". */
export function formatUsd(amount) {
    return `$${(Number(amount) || 0).toFixed(2)}`;
}
