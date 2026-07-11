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
        swimmerSurcharge: 5,
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
