/**
 * Golden test for @gpsa/swimparse.
 *
 * Guards two things at once:
 *  1. Regression — each fixture must still parse to its committed golden snapshot.
 *  2. Cross-format agreement — the SDIF and HY3 files describe the SAME meet, so
 *     their parses must agree swim-for-swim. This is the check that caught the
 *     event-0 and medley-stroke bugs; it stays on permanently.
 *
 * Fixtures are synthetic (public figures, birth years shifted to match age
 * groups) — see fixtures/README.md. No real swimmer data.
 *
 * Run: `node --test` from the package root.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from '../src/index.js';

const dir = new URL('./fixtures/', import.meta.url);
const read = (name) => readFileSync(new URL(name, dir), 'latin1');
const readJson = (name) => JSON.parse(readFileSync(new URL(name, dir), 'utf8'));

const sd3 = parse(read('gg-at-ww.sd3'), { filename: 'gg-at-ww.sd3' });
const hy3 = parse(read('gg-at-ww.hy3'), { filename: 'gg-at-ww.hy3' });

// A NormalizedMeet's canonical form is its JSON; normalize away undefined-valued
// optional keys before comparing to the committed snapshot.
const asJson = (v) => JSON.parse(JSON.stringify(v));

test('SDIF fixture matches its golden snapshot', () => {
    assert.deepStrictEqual(asJson(sd3), readJson('gg-at-ww.sd3.golden.json'));
});

test('HY3 fixture matches its golden snapshot', () => {
    assert.deepStrictEqual(asJson(hy3), readJson('gg-at-ww.hy3.golden.json'));
});

test('both formats agree on meet identity', () => {
    assert.equal(sd3.meet.startDate, hy3.meet.startDate);
    assert.deepStrictEqual(
        sd3.teams.map((t) => t.code).sort(),
        hy3.teams.map((t) => t.code).sort(),
    );
    assert.equal(sd3.events.length, hy3.events.length);
    assert.equal(sd3.swimmers.length, hy3.swimmers.length);
});

// Index individual results by swimmer + event (identities are identical across files).
function individualIndex(meet) {
    const map = new Map();
    for (const ev of meet.events) {
        if (ev.type !== 'individual') continue;
        for (const r of ev.results) {
            map.set(`${r.swimmerName}|${ev.distance}|${ev.stroke}|${ev.gender}|${ev.ageGroup.label}`, r);
        }
    }
    return map;
}

test('SDIF and HY3 agree on every individual swim', () => {
    const a = individualIndex(sd3);
    const b = individualIndex(hy3);
    const keys = new Set([...a.keys(), ...b.keys()]);

    let matched = 0;
    let bothDq = 0;
    for (const k of keys) {
        const ra = a.get(k);
        const rb = b.get(k);
        assert.ok(ra, `only in HY3: ${k}`);
        assert.ok(rb, `only in SDIF: ${k}`);
        matched++;

        if (ra.disqualified && rb.disqualified) bothDq++;
        else assert.equal(ra.disqualified, rb.disqualified, `DQ mismatch: ${k}`);

        // Clean (non-DQ) swims must match to the hundredth.
        if (ra.finalTime && rb.finalTime) {
            assert.ok(Math.abs(ra.finalTime.seconds - rb.finalTime.seconds) < 0.005, `time mismatch: ${k}`);
        }
    }
    assert.equal(matched, 257, 'expected 257 individual swims in both files');
    assert.equal(bothDq, 21, 'expected 21 disqualifications agreed by both formats');
});

test('HY3 retains the swum time and a reason on a DQ; SDIF nulls the time', () => {
    // Cochran→"Newton, Isaac", Boys 15-18 50m Butterfly is a known DQ in this meet.
    const find = (meet) =>
        meet.events
            .flatMap((e) => e.results.map((r) => ({ e, r })))
            .find(({ r }) => r.swimmerName === 'Newton, Isaac' && r.disqualified);

    const h = find(hy3);
    const s = find(sd3);
    assert.ok(h && s, 'expected the DQ in both files');
    assert.ok(h.r.finalTime && h.r.finalTime.seconds > 0, 'HY3 keeps the DQ time');
    assert.ok(h.r.dqReason && h.r.dqReason.length > 0, 'HY3 carries a DQ reason');
    assert.equal(s.r.finalTime, null, 'SDIF nulls the DQ time');
});
