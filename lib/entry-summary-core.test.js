/**
 * Golden test for the entry-summary billing contract.
 *
 * This is the first web production consumer of swimparse, and it drives a
 * money-facing document — so the billable counts are pinned against the
 * sanitized synthetic fixture (celebrity swimmers, fake DOBs). If a future
 * swimparse change alters how D0/E0/F0 records map to counts, this fails loudly
 * instead of quietly mis-charging a team.
 *
 * Run: node --test lib/entry-summary-core.test.js   (from the app-tools root)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { summarizeEntries, summarizeByTeam, collectBillables, compareBillables, computeFees, MEETS, formatUsd } from './entry-summary-core.js';

const FIXTURE = fileURLToPath(new URL('../swimparse/test/fixtures/gg-at-ww.sd3', import.meta.url));
const sd3 = readFileSync(FIXTURE, 'utf8');
const hy3 = readFileSync(fileURLToPath(new URL('../swimparse/test/fixtures/gg-at-ww.hy3', import.meta.url)), 'utf8');

test('summarizeEntries: billable counts match the golden fixture', () => {
    const s = summarizeEntries(sd3, { filename: 'gg-at-ww.sd3' });
    assert.equal(s.individualEntries, 257, 'individual entries = D0 count');
    assert.equal(s.relayEntries, 12, 'relay entries = E0 count');
    assert.equal(s.swimmers, 130, 'swimmers = distinct individual + relay-leg swimmers');
    assert.equal(s.relayOnlySwimmers, 1, 'relay-only swimmers are counted for the surcharge');
    assert.equal(s.swimmerNames.length, s.swimmers, 'swimmerNames is deduped to the swimmer count');
});

test('summarizeEntries: never returns PII (birthdates stripped at the parse boundary)', () => {
    const s = summarizeEntries(sd3, { filename: 'gg-at-ww.sd3' });
    const json = JSON.stringify(s);
    assert.ok(!/birth|dob/i.test(json), 'no birthDate/dob keys survive');
    assert.ok(!/\b\d{8}\b/.test(json), 'no 8-digit date blobs survive');
});

test('computeFees: Summer Splash — relays free', () => {
    const s = summarizeEntries(sd3);
    const f = computeFees(s, 'summer-splash');
    assert.equal(f.meet, 'Summer Splash');
    assert.equal(f.total, 130 * 5 + 257 * 5 + 12 * 0); // 1935
    assert.equal(f.lines.find((l) => l.label === 'Relay events').amount, 0);
    assert.deepEqual(f.notes, MEETS['summer-splash'].notes);
});

test('computeFees: City Meet — relays $20 each', () => {
    const s = summarizeEntries(sd3);
    const f = computeFees(s, 'city-meet');
    assert.equal(f.meet, 'City Meet');
    assert.equal(f.total, 130 * 6 + 257 * 5 + 12 * 20); // 2305
    assert.equal(f.lines.find((l) => l.label === 'Relay events').amount, 240);
    assert.deepEqual(f.notes, MEETS['city-meet'].notes);
});

test('computeFees: is a pure function of the (editable) counts, not the file', () => {
    // The UI lets the rep correct counts before generating; fees follow the numbers.
    const f = computeFees({ swimmers: 20, individualEntries: 51, relayEntries: 3 }, 'city-meet');
    assert.equal(f.total, 20 * 6 + 51 * 5 + 3 * 20); // 435 — the Wendwood cross-check
});

test('summarizeByTeam: per-team counts match, sum to the aggregate', () => {
    const teams = summarizeByTeam(sd3);
    assert.deepEqual(teams.map((t) => t.teamName), ['Glendale Gators', 'Wendwood Wahoos']);
    const gg = teams.find((t) => t.teamCode === 'GG');
    const ww = teams.find((t) => t.teamCode === 'WW');
    assert.deepEqual(
        { s: gg.swimmers, i: gg.individualEntries, r: gg.relayEntries },
        { s: 97, i: 166, r: 6 },
    );
    assert.deepEqual(
        { s: ww.swimmers, i: ww.individualEntries, r: ww.relayEntries },
        { s: 33, i: 91, r: 6 },
    );
    // per-team totals reconcile to the whole-file aggregate
    assert.equal(gg.individualEntries + ww.individualEntries, 257);
    assert.equal(gg.relayEntries + ww.relayEntries, 12);
});

test('summarizeByTeam: merged .hy3 parses identically to .sd3', () => {
    const strip = (t) => t.map(({ teamCode, swimmers, individualEntries, relayEntries }) =>
        ({ teamCode, swimmers, individualEntries, relayEntries }));
    assert.deepEqual(strip(summarizeByTeam(hy3)), strip(summarizeByTeam(sd3)));
});

test('summarizeByTeam: never returns PII', () => {
    assert.ok(!/birth|dob|\b\d{8}\b/i.test(JSON.stringify(summarizeByTeam(hy3))));
});

test('treasurer report: per-team City Meet fees sum to the grand total', () => {
    const teams = summarizeByTeam(sd3);
    const grand = teams.reduce((sum, t) => sum + computeFees(t, 'city-meet').total, 0);
    assert.equal(grand, 2305); // matches the whole-file City Meet total
    const gg = computeFees(teams.find((t) => t.teamCode === 'GG'), 'city-meet');
    assert.equal(gg.total, 97 * 6 + 166 * 5 + 6 * 20); // 1532
});

// Builds a single-team collectBillables-shaped Map from a compact spec:
// entrants: { 'Name': ['ev1','ev2'] }, relaySwimmers: ['Name'], relays: ['3|A']
function makeBillables(code, name, { entrants = {}, relaySwimmers = [], relays = [] }) {
    const swimmers = new Set([...Object.keys(entrants), ...relaySwimmers]);
    const eventsBySwimmer = new Map(Object.entries(entrants).map(([n, evs]) => [n, new Set(evs)]));
    return new Map([[code, { teamCode: code, teamName: name, swimmers, eventsBySwimmer, relays: new Set(relays), labels: new Map() }]]);
}

test('collectBillables: per-team sets reconcile to the summarizeByTeam counts', () => {
    const bills = collectBillables(sd3);
    const teams = summarizeByTeam(sd3);
    for (const t of teams) {
        const b = bills.get(t.teamCode);
        assert.equal(b.swimmers.size, t.swimmers, `${t.teamCode} swimmers`);
        const indiv = [...b.eventsBySwimmer.values()].reduce((n, s) => n + s.size, 0);
        assert.equal(indiv, t.individualEntries, `${t.teamCode} individual entries`);
        assert.equal(b.relays.size, t.relayEntries, `${t.teamCode} relays`);
    }
});

test('compareBillables: new swimmers + events charged, scratches kept, same-swimmer swap is a wash', () => {
    // Seeding: Stay (ev 5) + Swapper (ev 6) + Scratch (ev 8, leaves entirely)
    const seeded = makeBillables('GG', 'Glendale Gators', {
        entrants: { 'Stay, S': ['5', '11'], 'Swapper, W': ['6'], 'Scratch, X': ['8'] },
    });
    // Post-meet: Stay unchanged; Swapper moved 6→16 (a wash); Scratch gone;
    // New swimmer with 2 events (fully added)
    const final = makeBillables('GG', 'Glendale Gators', {
        entrants: { 'Stay, S': ['5', '11'], 'Swapper, W': ['16'], 'New, N': ['9', '10'] },
    });
    const [gg] = compareBillables(seeded, final);

    // Surcharge: union of names — New added, Scratch not refunded
    assert.equal(gg.seeded.swimmers, 3);
    assert.equal(gg.added.swimmers, 1, 'only the genuinely new swimmer is added');
    assert.equal(gg.billable.swimmers, 4, 'scratched swimmer still billed');

    // Individual events, per swimmer:
    //   Stay 2→2 (+0), Swapper 1→1 (+0 wash), Scratch 1→0 kept, New 0→2 (+2)
    assert.equal(gg.seeded.individualEntries, 4, '2+1+1');
    assert.equal(gg.added.individualEntries, 2, 'only the new swimmer’s events; the swap is a wash');
    assert.equal(gg.billable.individualEntries, 6, 'kept 4 seeded (Scratch not reduced) + 2 new');
});

test('compareBillables: the addendum detail explains the charge without contradicting it', () => {
    // Same scenario as above, so the detail is checked against a known bill.
    const seeded = makeBillables('GG', 'Glendale Gators', {
        entrants: { 'Stay, S': ['5', '11'], 'Swapper, W': ['6'], 'Scratch, X': ['8'] },
        relays: ['20|A'],
    });
    const final = makeBillables('GG', 'Glendale Gators', {
        entrants: { 'Stay, S': ['5', '11'], 'Swapper, W': ['16'], 'New, N': ['9', '10'] },
        relays: ['20|A', '21|B'],
    });
    const [gg] = compareBillables(seeded, final);
    const by = Object.fromEntries(gg.detail.swimmers.map((d) => [d.name, d]));

    // Unmoved swimmers are suppressed — the addendum lists only what changed.
    assert.deepEqual(Object.keys(by).sort(), ['New, N', 'Scratch, X', 'Swapper, W']);
    assert.equal(by['Stay, S'], undefined, 'a swimmer who did not move is not listed');

    // The wash: entries moved, nothing charged. This is the row that stops the
    // "you billed me for an event I moved" phone call.
    assert.equal(by['Swapper, W'].status, 'swapped');
    assert.equal(by['Swapper, W'].addedCharged, 0, 'a same-swimmer move is never charged');
    assert.equal(by['Swapper, W'].charged, 1);
    assert.deepEqual(by['Swapper, W'].gainedEvents, ['16']);
    assert.deepEqual(by['Swapper, W'].droppedEvents, ['6']);

    // The scratch: kept on the bill, and the addendum says so.
    assert.equal(by['Scratch, X'].status, 'scratched');
    assert.equal(by['Scratch, X'].charged, 1, 'scratches are not refunded');
    assert.equal(by['Scratch, X'].addedCharged, 0);

    // The genuinely new swimmer: every event charged.
    assert.equal(by['New, N'].status, 'new');
    assert.equal(by['New, N'].addedCharged, 2);
    assert.deepEqual(gg.detail.newSwimmers, ['New, N']);

    // Relay adds are named; the pre-existing relay is not listed.
    assert.deepEqual(gg.detail.addedRelays, ['21|B']);

    // The addendum must reconcile to the invoice: charged adds sum to the
    // billed added-entry count.
    const sumAdded = gg.detail.swimmers.reduce((n, d) => n + d.addedCharged, 0);
    assert.equal(sumAdded, gg.added.individualEntries, 'detail sums to the billed adds');
});

test('compareBillables: a relay-only new swimmer is listed, so the addendum foots to the bill', () => {
    // Nobody new in the individual events; the new swimmer only swam a relay leg.
    // They still owe the surcharge, so the addendum must list them or the
    // per-swimmer money will not add up to the invoice.
    const seeded = makeBillables('WW', 'Wendwood', { entrants: { 'A, A': ['1'] }, relays: ['20|A'] });
    const final = makeBillables('WW', 'Wendwood', {
        entrants: { 'A, A': ['1'] }, relaySwimmers: ['Relayonly, R'], relays: ['20|A'],
    });
    const [ww] = compareBillables(seeded, final);

    assert.equal(ww.added.swimmers, 1, 'the relay-leg swimmer is a new billable swimmer');
    const row = ww.detail.swimmers.find((d) => d.name === 'Relayonly, R');
    assert.ok(row, 'relay-only new swimmer appears in the addendum');
    assert.equal(row.status, 'new');
    assert.equal(row.relayOnly, true);
    assert.equal(row.addedCharged, 0, 'no individual events to charge');

    // The identity the addendum's footer depends on, priced at City Meet rates.
    const m = MEETS['city-meet'];
    const ledger = ww.detail.swimmers.reduce((sum, d) => {
        const surcharge = ww.detail.newSwimmers.includes(d.name) ? m.swimmerSurcharge : 0;
        return sum + surcharge + d.addedCharged * m.individualEntry;
    }, 0) + ww.detail.addedRelays.length * m.relayEntry;
    assert.equal(ledger, computeFees(ww.added, 'city-meet').total,
        'per-swimmer ledger foots to the team deck-add total');
});

test('compareBillables: a team present in only one file still bills its seeding', () => {
    const seededOnly = makeBillables('COL', 'Colony', { entrants: { 'A, A': ['1', '2'] }, relays: ['3|A'] });
    const [col] = compareBillables(seededOnly, new Map());
    assert.deepEqual(col.billable, { swimmers: 1, individualEntries: 2, relayEntries: 1 });
    assert.deepEqual(col.added, { swimmers: 0, individualEntries: 0, relayEntries: 0 });

    const finalOnly = makeBillables('POQ', 'Poquoson', { entrants: { 'B, B': ['1'] } });
    const [poq] = compareBillables(new Map(), finalOnly);
    assert.deepEqual(poq.billable, { swimmers: 1, individualEntries: 1, relayEntries: 0 });
    assert.deepEqual(poq.added, { swimmers: 1, individualEntries: 1, relayEntries: 0 });
});

test('formatUsd', () => {
    assert.equal(formatUsd(415), '$415.00');
    assert.equal(formatUsd(0), '$0.00');
});
