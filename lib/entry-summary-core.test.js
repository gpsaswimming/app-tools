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

import { summarizeEntries, computeFees, MEETS, formatUsd } from './entry-summary-core.js';

const FIXTURE = fileURLToPath(new URL('../swimparse/test/fixtures/gg-at-ww.sd3', import.meta.url));
const sd3 = readFileSync(FIXTURE, 'utf8');

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
    assert.equal(f.total, 130 * 5 + 257 * 5 + 12 * 20); // 2175
    assert.equal(f.lines.find((l) => l.label === 'Relay events').amount, 240);
    assert.deepEqual(f.notes, MEETS['city-meet'].notes);
});

test('computeFees: is a pure function of the (editable) counts, not the file', () => {
    // The UI lets the rep correct counts before generating; fees follow the numbers.
    const f = computeFees({ swimmers: 20, individualEntries: 51, relayEntries: 3 }, 'city-meet');
    assert.equal(f.total, 20 * 5 + 51 * 5 + 3 * 20); // 415 — the Wendwood cross-check
});

test('formatUsd', () => {
    assert.equal(formatUsd(415), '$415.00');
    assert.equal(formatUsd(0), '$0.00');
});
