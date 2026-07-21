/**
 * GPSA dual-meet scoring.
 *
 * Points are a *consumer* concern, not a parse concern: SDIF stores them but HY3
 * does not (Hy-Tek computes standings separately).
 *
 * SDIF points are authoritative and are used verbatim: they already encode the
 * meet's official standings, including tie / place-slide adjustments (a 2nd or
 * 3rd place can carry more than the table's points when faster swimmers are
 * exhibition or DQ) and the exhibition/DQ/NS zeros. A place -> points table
 * cannot reproduce those, so for SDIF we trust the stored value rather than
 * recomputing it. HY3 carries no points, so there we DO assign them from
 * finishing place via the league ruleset. Either way, `score()` yields the same
 * NormalizedMeet contract, so consumers call it uniformly.
 *
 * The point *values* (used only for the HY3 place-based path) are league config
 * (a league profile's `scoring` block):
 *   individual: 1st=5, 2nd=3, 3rd=1, 4th+=0   (scoring.individualPlaces)
 *   relay:      winner=7, else 0               (scoring.relayPlaces)
 * The *structural* rules stay here as engine policy, not config: only
 * single-gender, numbered relays score (the 8 & Under mixed "B" relays are
 * unofficial and score 0). Both were derived from real SwimTopia SDIF output.
 */

import { GPSA } from './league.js';

/**
 * Builds a dual-meet ruleset from a league profile's `scoring` block. The place
 * arrays are indexed by place (index 0 = 1st); unlisted places score 0.
 * @param {import('./league.js').ScoringProfile} scoring
 * @returns {{ pointsFor: (event: import('./model.js').Event, result: any) => number }}
 */
export function rulesetFromScoring(scoring) {
    const individual = scoring.individualPlaces || [];
    const relay = scoring.relayPlaces || [];
    return {
        pointsFor(event, result) {
            // Only completed, official swims score. DQ / NS / exhibition and
            // unplaced swims all carry a null place, so they fall through to 0.
            if (result.status !== 'ok' || result.place == null) return 0;

            if (event.type === 'individual') {
                return individual[result.place - 1] || 0;
            }
            // Relay: mixed-gender or unnumbered relays are unofficial and don't score.
            if (event.gender === 'X' || !event.number) return 0;
            return relay[result.place - 1] || 0;
        },
    };
}

/**
 * The default GPSA dual-meet ruleset (point values from the built-in profile).
 * @type {{ pointsFor: (event: import('./model.js').Event, result: any) => number }}
 */
export const GPSA_DUAL = rulesetFromScoring(GPSA.scoring);

/**
 * Assigns points to every result in `meet` (in place) and returns team totals.
 *
 * @param {import('./model.js').NormalizedMeet} meet
 * @param {{ pointsFor: Function }} [rules] scoring ruleset (defaults to GPSA dual)
 * @returns {Record<string, number>} teamCode → total points
 */
export function score(meet, rules = GPSA_DUAL) {
    /** @type {Record<string, number>} */
    const totals = {};
    // HY3 stores no points, so derive them from finishing place. SDIF's points
    // are the meet's official standings (see module docs) and are used verbatim.
    const derivePoints = meet.format !== 'sdif-v3';
    for (const event of meet.events) {
        for (const result of event.results) {
            const points = derivePoints ? rules.pointsFor(event, result) : recordedPoints(result);
            result.points = points;
            if (result.teamCode) {
                totals[result.teamCode] = (totals[result.teamCode] || 0) + points;
            }
        }
    }
    return totals;
}

// SDIF already zeroes exhibition / DQ / NS and unplaced swims; this guard makes
// that explicit so a stray stored value can never let a non-scoring swim count.
function recordedPoints(result) {
    if (result.status !== 'ok' || result.place == null) return 0;
    return result.points || 0;
}

/**
 * Flags results whose recorded finishing PLACE disagrees with the points they
 * were awarded — the fingerprint of a DQ / exhibition that wasn't reconciled in
 * the place order (e.g. a swim kept its "2nd place" label while correctly
 * earning 1st-place points because the swimmer ahead was disqualified).
 *
 * SwimTopia derives points from the timed order but can leave the place column
 * stale, so this catches the mismatch and hands it to a human to review before
 * results are published. It does not change any score. SDIF only — HY3 stores
 * no points to check against.
 *
 * @param {import('./model.js').NormalizedMeet} meet
 * @param {{ pointsFor: Function }} [rules] scoring ruleset (defaults to GPSA dual)
 * @returns {Array<{eventNumber:string, eventDescription:string, swimmerName:string,
 *   teamCode:string, place:number, points:number, expectedPoints:number}>}
 */
export function auditPlacePoints(meet, rules = GPSA_DUAL) {
    if (meet.format !== 'sdif-v3') return [];
    /** @type {ReturnType<typeof auditPlacePoints>} */
    const issues = [];
    for (const event of meet.events) {
        for (const result of event.results) {
            if (result.status !== 'ok' || result.place == null) continue;
            // Points the recorded place label implies under the scoring table.
            const expectedPoints = rules.pointsFor(event, result);
            if (result.points !== expectedPoints) {
                issues.push({
                    eventNumber: event.number,
                    eventDescription: event.description,
                    swimmerName: result.swimmerName ?? `${result.teamCode} ${result.relayLetter ?? ''} relay`.trim(),
                    teamCode: result.teamCode,
                    place: result.place,
                    points: result.points,
                    expectedPoints,
                });
            }
        }
    }
    return issues;
}
