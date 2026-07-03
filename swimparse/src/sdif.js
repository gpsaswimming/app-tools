/**
 * SDIF v3 (.sd3) adapter → NormalizedMeet.
 *
 * Fixed-width text. Record types used by GPSA:
 *   B1 meet · B2 host · C1 team · D0 individual result · D3 swimmer reg
 *   E0 relay result · F0 relay swimmer
 *
 * Unlike the legacy publicity parser, this keeps EVERY individual/relay result
 * (exhibition, DQ, no-show, non-placing) — the lossless-superset rule.
 */

import { SDIF_STROKE, GENDER, GENDER_DISPLAY, ageGroup } from './constants.js';
import { timeFromText, normalizeDate } from './times.js';
import { displayTeamCode, improveMeetName, deriveSwimmers } from './model.js';

// Column offsets (0-indexed, [start, end)).
const OFF = {
    D0: { name: [11, 39], birth: [55, 63], seed: [95, 103], final: [115, 123], event: [72, 76], place: [135, 138], points: [138, 142] },
    D0evt: { gender: [66, 67], dist: [67, 71], stroke: [71, 72], age: [76, 80] },
    E0: { letter: [11, 12], final: [72, 80], event: [26, 30], place: [92, 95], points: [95, 99] },
    E0evt: { gender: [20, 21], dist: [21, 25], stroke: [25, 26], age: [30, 34] },
    F0: { name: [22, 50] },
};

const slice = (line, [a, b]) => (line.length >= a ? line.slice(a, b).trim() : '');

/**
 * @param {string} content raw .sd3 text
 * @returns {import('./model.js').NormalizedMeet}
 */
export function parseSdif(content) {
    const lines = String(content).split(/\r?\n/);

    /** @type {import('./model.js').MeetInfo} */
    const meet = { name: '', rawName: '', startDate: null };
    /** @type {Map<string, import('./model.js').Team>} */
    const teamMap = new Map();
    /** @type {Map<string, import('./model.js').Event>} */
    const eventMap = new Map();

    let currentTeam = null; // raw code
    let lastRelay = null;

    const source = {};

    for (const line of lines) {
        const code = line.slice(0, 2);
        try {
            switch (code) {
                case 'A0':
                    source.software = slice(line, [43, 63]) || undefined;
                    break;
                case 'B1':
                    meet.rawName = slice(line, [11, 41]);
                    meet.name = meet.rawName;
                    meet.startDate = normalizeDate(slice(line, [121, 129]));
                    lastRelay = null;
                    break;
                case 'B2':
                    if (!meet.hostName) meet.hostName = slice(line, [11, 41]);
                    break;
                case 'C1': {
                    const raw = slice(line, [11, 17]);
                    currentTeam = raw;
                    if (!teamMap.has(raw)) {
                        teamMap.set(raw, {
                            code: displayTeamCode(raw),
                            fullCode: raw,
                            name: slice(line, [17, 47]),
                        });
                    }
                    lastRelay = null;
                    break;
                }
                case 'D0':
                    lastRelay = null;
                    parseD0(line, eventMap, currentTeam, teamMap);
                    break;
                case 'E0':
                    lastRelay = parseE0(line, eventMap, currentTeam, teamMap);
                    break;
                case 'F0':
                    if (lastRelay) {
                        const name = slice(line, OFF.F0.name);
                        if (name) lastRelay.legs.push({ name, legOrder: lastRelay.legs.length + 1 });
                    }
                    break;
            }
        } catch {
            /* skip malformed line */
        }
    }

    const events = [...eventMap.values()];
    for (const ev of events) {
        ev.results.sort((a, b) => (a.place ?? 999) - (b.place ?? 999));
    }
    const teams = [...teamMap.values()];
    improveMeetName(meet, teams);
    const swimmers = deriveSwimmers(events);

    return { format: 'sdif-v3', source, meet, teams, swimmers, events };
}

function statusFromText(raw) {
    const t = String(raw).trim().toUpperCase();
    if (t.startsWith('DQ')) return 'dq';
    if (t.startsWith('NS')) return 'ns';
    if (t.startsWith('DNF')) return 'dnf';
    if (t.startsWith('SCR')) return 'scratch';
    return 'ok';
}

function parseD0(line, eventMap, currentTeam, teamMap) {
    if (!currentTeam) return;
    // Event number 0 = an unseeded/unofficial event (e.g. 8 & Under "B" relays).
    // Keep it (lossless), but bucket unnumbered events by description so two
    // distinct ones don't merge under a shared "0".
    const eventNum = slice(line, OFF.D0.event);
    const ev = ensureEvent(eventMap, buildEvent(line, 'individual', OFF.D0evt), eventNum);

    const finalRaw = slice(line, OFF.D0.final);
    const status = statusFromText(finalRaw);
    const placeNum = parseInt(slice(line, OFF.D0.place), 10);

    /** @type {import('./model.js').IndividualResult} */
    ev.results.push({
        kind: 'individual',
        swimmerName: slice(line, OFF.D0.name),
        teamCode: teamMap.get(currentTeam)?.code || currentTeam,
        birthDate: normalizeDate(slice(line, OFF.D0.birth)),
        seedTime: timeFromText(slice(line, OFF.D0.seed)),
        finalTime: status === 'ok' ? timeFromText(finalRaw) : null,
        status,
        disqualified: status === 'dq',
        place: Number.isNaN(placeNum) ? null : placeNum || null,
        points: parseFloat(slice(line, OFF.D0.points)) || 0,
    });
}

function parseE0(line, eventMap, currentTeam, teamMap) {
    if (!currentTeam) return null;
    const eventNum = slice(line, OFF.E0.event);
    const ev = ensureEvent(eventMap, buildEvent(line, 'relay', OFF.E0evt), eventNum);

    const finalRaw = slice(line, OFF.E0.final);
    const status = statusFromText(finalRaw);
    const placeNum = parseInt(slice(line, OFF.E0.place), 10);

    /** @type {import('./model.js').RelayResult} */
    const relay = {
        kind: 'relay',
        teamCode: teamMap.get(currentTeam)?.code || currentTeam,
        relayLetter: slice(line, OFF.E0.letter),
        seedTime: null,
        finalTime: status === 'ok' ? timeFromText(finalRaw) : null,
        status,
        disqualified: status === 'dq',
        place: Number.isNaN(placeNum) ? null : placeNum || null,
        points: parseFloat(slice(line, OFF.E0.points)) || 0,
        legs: [],
    };
    ev.results.push(relay);
    return relay;
}

function buildEvent(line, type, off) {
    const gender = GENDER[slice(line, off.gender)] || 'X';
    const distance = parseInt(slice(line, off.dist), 10) || 0;
    const stroke = SDIF_STROKE[slice(line, off.stroke)] || `Stroke ${slice(line, off.stroke)}`;
    const ageCode = slice(line, off.age).padEnd(4);
    const ag = ageGroup(ageCode.slice(0, 2), ageCode.slice(2, 4));
    const agLabel = type === 'relay' && ag.label === 'Open' ? '' : ag.label;
    const description = `${GENDER_DISPLAY[gender]} ${agLabel} ${distance}m ${stroke}${type === 'relay' ? ' Relay' : ''}`
        .replace(/\s+/g, ' ')
        .trim();
    return { type, gender, distance, stroke, ageGroup: ag, description, results: [] };
}

function ensureEvent(eventMap, built, rawNumber) {
    const numbered = rawNumber && rawNumber !== '0';
    const key = numbered ? rawNumber : `u:${built.description}`;
    let ev = eventMap.get(key);
    if (!ev) {
        ev = { number: numbered ? rawNumber : '', ...built };
        eventMap.set(key, ev);
    }
    return ev;
}
