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

import { summarizeEntries, summarizeByTeam, mergeTeamCounts, computeFees, MEETS, formatUsd } from './entry-summary-core.js';

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

test('mergeTeamCounts: bill = max(seeding, post-meet) per metric — scratches never reduce, adds are charged', () => {
    const seeded = [
        { teamCode: 'GG', teamName: 'Glendale Gators', swimmers: 10, individualEntries: 30, relayEntries: 2 },
        { teamCode: 'WW', teamName: 'Wendwood Wahoos', swimmers: 8, individualEntries: 20, relayEntries: 2 },
    ];
    const final = [
        // GG scratched an event (29 < 30) but deck-added a swimmer + a relay → bill holds/grows
        { teamCode: 'GG', teamName: 'Glendale Gators', swimmers: 12, individualEntries: 29, relayEntries: 3 },
        // WW unchanged
        { teamCode: 'WW', teamName: 'Wendwood Wahoos', swimmers: 8, individualEntries: 20, relayEntries: 2 },
    ];
    const rows = mergeTeamCounts(seeded, final);
    const gg = rows.find((r) => r.teamCode === 'GG');
    // scratch of an individual does NOT drop the count below seeding
    assert.deepEqual(gg.billable, { swimmers: 12, individualEntries: 30, relayEntries: 3 });
    assert.deepEqual(gg.added, { swimmers: 2, individualEntries: 0, relayEntries: 1 });
    const ww = rows.find((r) => r.teamCode === 'WW');
    assert.deepEqual(ww.added, { swimmers: 0, individualEntries: 0, relayEntries: 0 });
});

test('mergeTeamCounts: a team present in only one file still bills its seeding', () => {
    const seeded = [{ teamCode: 'COL', teamName: 'Colony', swimmers: 5, individualEntries: 12, relayEntries: 1 }];
    const rows = mergeTeamCounts(seeded, []);
    assert.deepEqual(rows[0].billable, { swimmers: 5, individualEntries: 12, relayEntries: 1 });
    assert.deepEqual(rows[0].added, { swimmers: 0, individualEntries: 0, relayEntries: 0 });
    // a brand-new team appearing only post-meet is billed its full post-meet count as "added"
    const rows2 = mergeTeamCounts([], [{ teamCode: 'POQ', teamName: 'Poquoson', swimmers: 3, individualEntries: 7, relayEntries: 0 }]);
    assert.deepEqual(rows2[0].billable, { swimmers: 3, individualEntries: 7, relayEntries: 0 });
    assert.deepEqual(rows2[0].added, { swimmers: 3, individualEntries: 7, relayEntries: 0 });
});

test('formatUsd', () => {
    assert.equal(formatUsd(415), '$415.00');
    assert.equal(formatUsd(0), '$0.00');
});
