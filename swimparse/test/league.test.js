/**
 * Tests for league profiles: age-group computation, the DOB firewall, and
 * scoring-as-config.
 *
 * The load-bearing guarantees:
 *  1. Parsing WITH a league strips every birthdate/usasId and stamps ageProfile
 *     (the parse boundary is the PII firewall).
 *  2. Census age-groups are correct off DOB + the June-1 reference, independent
 *     of which event a swimmer swam (swim-ups grouped by real age).
 *  3. Point values now come from the profile's `scoring` block WITHOUT changing
 *     any score — score() still reproduces the SDIF-stored points.
 *  4. The built-in GPSA object and the portable leagues/gpsa.json agree.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
    parse,
    score,
    GPSA,
    ageOn,
    ageGroupLabel,
    seasonReferenceDate,
} from '../src/index.js';

const dir = new URL('./fixtures/', import.meta.url);
const read = (name) => readFileSync(new URL(name, dir), 'latin1');
const raw = (name) => parse(read(name), { filename: name });
const leagued = (name) => parse(read(name), { filename: name, league: GPSA });

// ── unit: age arithmetic + banding ───────────────────────────────────────────

test('ageOn counts whole years, decrementing before the reference day', () => {
    assert.equal(ageOn('2009-03-14', '2026-06-01'), 17); // birthday passed
    assert.equal(ageOn('2008-09-23', '2026-06-01'), 17); // birthday not yet reached
    assert.equal(ageOn('2020-06-01', '2026-06-01'), 6);  // exactly on the reference
    assert.equal(ageOn(null, '2026-06-01'), null);
});

test('seasonReferenceDate anchors MM-DD to the meet season year', () => {
    assert.equal(seasonReferenceDate('2026-06-29', GPSA), '2026-06-01');
    assert.equal(seasonReferenceDate(null, GPSA), null);
    assert.equal(seasonReferenceDate('2026-06-29', { ageUp: { reference: 'meet-date' } }), '2026-06-29');
});

test('ageGroupLabel maps ages onto GPSA bands, edges included', () => {
    const on = (b) => ageGroupLabel(b, '2026-06-29', GPSA);
    assert.equal(on('2020-06-01'), '6&U');   // age 6 exactly on the reference
    assert.equal(on('2019-05-01'), '7-8');   // age 7
    assert.equal(on('2016-01-01'), '9-10');  // age 10
    assert.equal(on('2008-01-01'), '15-18'); // age 18
    assert.equal(on('2007-01-01'), null);    // age 19 — out of range
});

// ── the DOB firewall ─────────────────────────────────────────────────────────

for (const file of ['gg-at-ww.sd3', 'gg-at-ww.hy3']) {
    test(`${file}: league parse is DOB-free and age-grouped`, () => {
        const meet = leagued(file);
        assert.equal(meet.ageProfile, 'gpsa');

        const isoDate = /\d{4}-\d{2}-\d{2}/; // no birthdate should survive, incl. inside ids

        for (const s of meet.swimmers) {
            assert.ok(!('birthDate' in s), 'swimmer birthDate must be stripped');
            assert.ok(!('usasId' in s), 'swimmer usasId must be stripped');
            assert.ok(s.ageGroup, `swimmer ${s.fullName} should have an age-group`);
            assert.ok(!isoDate.test(s.id), `swimmer id must be DOB-free: ${s.id}`);
        }
        for (const ev of meet.events) {
            for (const r of ev.results) {
                assert.ok(!('birthDate' in r), 'result birthDate must be stripped');
                if (r.swimmerId) assert.ok(!isoDate.test(r.swimmerId), `swimmerId must be DOB-free: ${r.swimmerId}`);
            }
        }
        // Belt and braces: no birthDate key, and every swimmerId still resolves.
        assert.ok(!/"birthDate"/.test(JSON.stringify(meet)));
        const ids = new Set(meet.swimmers.map((s) => s.id));
        for (const ev of meet.events) {
            for (const r of ev.results) {
                if (r.swimmerId) assert.ok(ids.has(r.swimmerId), `dangling swimmerId: ${r.swimmerId}`);
            }
        }
    });
}

test('raw parse (no league) still carries DOB — the private artifact is unchanged', () => {
    const meet = raw('gg-at-ww.sd3');
    assert.equal(meet.ageProfile, undefined);
    assert.ok(meet.swimmers.some((s) => s.birthDate), 'raw parse keeps birthdates');
    assert.ok(meet.swimmers.every((s) => s.ageGroup === undefined), 'no age-group without a league');
});

test('SDIF and HY3 agree on every swimmer age-group', () => {
    const bySwimmer = (m) => new Map(m.swimmers.map((s) => [s.id, s.ageGroup]));
    const a = bySwimmer(leagued('gg-at-ww.sd3'));
    const b = bySwimmer(leagued('gg-at-ww.hy3'));
    assert.equal(a.size, b.size);
    for (const [id, ag] of a) assert.equal(b.get(id), ag, `age-group mismatch for ${id}`);
});

// ── scoring-as-config ────────────────────────────────────────────────────────

test('scoring config reproduces SDIF-stored points (unchanged by the refactor)', () => {
    const meet = raw('gg-at-ww.sd3');
    const original = meet.events.flatMap((e) => e.results.map((r) => r.points));
    score(meet);
    assert.deepStrictEqual(meet.events.flatMap((e) => e.results.map((r) => r.points)), original);
});

test('built-in GPSA equals the portable leagues/gpsa.json', () => {
    const json = JSON.parse(readFileSync(new URL('../leagues/gpsa.json', import.meta.url), 'utf8'));
    assert.deepStrictEqual(json, GPSA);
});
