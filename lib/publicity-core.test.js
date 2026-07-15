/**
 * Tests for the publicity results processor's handling of missing times.
 *
 * When a timing issue leaves a swimmer or heat with no usable time and no backup,
 * the scorekeeper clears the time in Meet Maestro (there is no "NT" code to type),
 * which exports as a blank SDIF final-time field. The swim still placed — GPSA
 * scores by place — so it must publish as "NT", never an empty cell or a fabricated
 * time.
 *
 * The synthetic fixture bakes in exactly one cleared time: Elvis Presley's Boys
 * 15-18 50m Butterfly win (a placed winner with the time blanked, mirroring a
 * real cleared-time swim). See swimparse/test/fixtures/README.md.
 *
 * Run: node --test lib/publicity-core.test.js   (from the app-tools root)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { displayTime, parseSdif, generateExportableHtml } from './publicity-core.js';

const FIXTURE = fileURLToPath(new URL('../swimparse/test/fixtures/gg-at-ww.sd3', import.meta.url));
const sd3 = readFileSync(FIXTURE, 'latin1');

test('displayTime: blank/whitespace/missing renders NT, real times pass through', () => {
    assert.equal(displayTime(''), 'NT');
    assert.equal(displayTime('   '), 'NT');
    assert.equal(displayTime(null), 'NT');
    assert.equal(displayTime(undefined), 'NT');
    assert.equal(displayTime('02:29.62'), '02:29.62');
    assert.equal(displayTime('28.15'), '28.15');
});

test('generateExportableHtml: the fixture\'s one cleared-time winner renders as NT', () => {
    const html = generateExportableHtml(parseSdif(sd3), 'logo.png');

    // Exactly one NT — the built-in cleared time — proving real times pass through
    // untouched while the blank one becomes NT rather than an empty cell.
    assert.equal((html.match(/>NT</g) || []).length, 1, 'exactly one winner (the cleared time) should be NT');

    // ...and it is the expected swim: Presley, Elvis wins only the 50m Butterfly,
    // so his winners-table row is the one carrying NT.
    const rowMatch = html.match(/<tr>(?:(?!<\/tr>).)*Presley, Elvis(?:(?!<\/tr>).)*<\/tr>/s);
    assert.ok(rowMatch, 'Presley, Elvis should appear as an event winner');
    assert.match(rowMatch[0], />NT</, 'the cleared-time winner\'s time cell should read NT');
});
