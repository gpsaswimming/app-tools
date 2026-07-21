/**
 * Tests for GPSA dual-meet scoring.
 *
 * The load-bearing guarantee: score() reproduces the points SwimTopia already
 * stored in the SDIF file, AND produces identical team totals for the HY3 file
 * (which carries no points). That's what lets consumers score both formats the
 * same way.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse, score, auditPlacePoints } from '../src/index.js';

const dir = new URL('./fixtures/', import.meta.url);
const load = (name) => parse(readFileSync(new URL(name, dir), 'latin1'), { filename: name });

test('score() reproduces the points SDIF already stored', () => {
    const meet = load('gg-at-ww.sd3');
    const original = meet.events.flatMap((e) => e.results.map((r) => r.points));
    score(meet);
    const rescored = meet.events.flatMap((e) => e.results.map((r) => r.points));
    assert.deepStrictEqual(rescored, original);
});

test('HY3 (no stored points) scores to the same team totals as SDIF', () => {
    assert.deepStrictEqual(score(load('gg-at-ww.hy3')), score(load('gg-at-ww.sd3')));
});

test('individual placing follows 5-3-1-0', () => {
    const meet = load('gg-at-ww.sd3');
    score(meet);
    const points = {};
    for (const e of meet.events) {
        if (e.type !== 'individual') continue;
        for (const r of e.results) if (r.status === 'ok' && r.place) points[r.place] = r.points;
    }
    assert.equal(points[1], 5);
    assert.equal(points[2], 3);
    assert.equal(points[3], 1);
    assert.equal(points[4], 0);
});

test('official relay winner scores 7; mixed/unnumbered relays score 0', () => {
    const meet = load('gg-at-ww.hy3');
    score(meet);
    for (const e of meet.events) {
        if (e.type !== 'relay') continue;
        const winner = e.results.find((r) => r.place === 1);
        if (!winner) continue;
        if (e.gender === 'X' || !e.number) assert.equal(winner.points, 0, `unofficial relay should score 0: ${e.description}`);
        else assert.equal(winner.points, 7, `official relay winner should score 7: ${e.description}`);
    }
});

test('DQ and no-show swims score 0', () => {
    const meet = load('gg-at-ww.hy3');
    score(meet);
    for (const e of meet.events) {
        for (const r of e.results) {
            if (r.status === 'dq' || r.status === 'ns') assert.equal(r.points, 0);
        }
    }
});

test('auditPlacePoints finds no false positives on a clean meet', () => {
    assert.deepStrictEqual(auditPlacePoints(load('gg-at-ww.sd3')), []);
});

test('auditPlacePoints flags a place/points mismatch (DQ not reconciled)', () => {
    // Synthetic SDIF meet: the swimmer ahead DQ'd but the place order was left
    // stale, so the winner kept a "2nd place" label while earning 1st-place pts.
    const meet = {
        format: 'sdif-v3',
        events: [
            {
                number: '35',
                type: 'individual',
                gender: 'M',
                description: 'Boys 9-10 50m Backstroke',
                results: [
                    { kind: 'individual', swimmerName: 'Sell, Charlie', teamCode: 'JRCC', status: 'dq', place: null, points: 0 },
                    { kind: 'individual', swimmerName: 'Myers, Xavier', teamCode: 'RRST', status: 'ok', place: 2, points: 5 },
                    { kind: 'individual', swimmerName: 'Grabowski, Grayson', teamCode: 'JRCC', status: 'ok', place: 3, points: 3 },
                ],
            },
        ],
    };
    const issues = auditPlacePoints(meet);
    assert.equal(issues.length, 2);
    assert.equal(issues[0].swimmerName, 'Myers, Xavier');
    assert.equal(issues[0].place, 2);
    assert.equal(issues[0].points, 5);
    assert.equal(issues[0].expectedPoints, 3); // what "2nd place" should score
});

test('auditPlacePoints is a no-op for HY3 (no stored points)', () => {
    assert.deepStrictEqual(auditPlacePoints(load('gg-at-ww.hy3')), []);
});
