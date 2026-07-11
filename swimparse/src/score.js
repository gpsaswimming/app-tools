/**
 * GPSA dual-meet scoring.
 *
 * Points are a *consumer* concern, not a parse concern: SDIF stores them but HY3
 * does not (Hy-Tek computes standings separately). So parsing leaves
 * `result.points` at 0 for HY3, and this helper assigns canonical points to
 * EITHER format identically. Running it on an SDIF meet reproduces the points
 * SwimTopia already stored (the golden test proves this), so consumers can call
 * `score()` uniformly regardless of source format.
 *
 * The point *values* are league config (a league profile's `scoring` block):
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
    for (const event of meet.events) {
        for (const result of event.results) {
            const points = rules.pointsFor(event, result);
            result.points = points;
            if (result.teamCode) {
                totals[result.teamCode] = (totals[result.teamCode] || 0) + points;
            }
        }
    }
    return totals;
}
