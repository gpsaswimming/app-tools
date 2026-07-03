/**
 * Time and date helpers.
 *
 * The two source formats encode times differently — SDIF as display text
 * ("1:11.35"), HY3 as raw seconds ("71.35") — but a NormalizedMeet always
 * carries BOTH: `{ text, seconds }`. These helpers convert either way.
 */

/**
 * @typedef {Object} SwimTime
 * @property {string} text     Canonical display, e.g. "1:11.35" or "28.05".
 * @property {number} seconds  Total seconds as a float (hundredths precision).
 */

/**
 * Parses an SDIF-style time string into seconds.
 * Handles "MM:SS.ss", "SS.ss", optional trailing course letter, and the
 * non-time sentinels DQ / NS / SCR / DNF / NT (→ null).
 *
 * @param {string} raw
 * @returns {number|null} seconds, or null if not a real time
 */
export function textToSeconds(raw) {
    if (!raw) return null;
    const s = String(raw).trim().replace(/[A-Za-z]+$/, '').trim(); // strip trailing course flag
    if (!s) return null;
    if (/^(DQ|NS|SCR|DNF|NT)$/i.test(String(raw).trim())) return null;
    if (s.includes(':')) {
        const [m, rest] = s.split(':');
        const minutes = parseInt(m, 10);
        const seconds = parseFloat(rest);
        if (Number.isNaN(minutes) || Number.isNaN(seconds)) return null;
        return round2(minutes * 60 + seconds);
    }
    const v = parseFloat(s);
    return Number.isNaN(v) || v <= 0 ? null : round2(v);
}

/**
 * Formats seconds as canonical display text ("1:11.35", "28.05").
 * @param {number|null} seconds
 * @returns {string}
 */
export function secondsToText(seconds) {
    if (seconds == null || Number.isNaN(seconds) || seconds <= 0) return '';
    const total = round2(seconds);
    const m = Math.floor(total / 60);
    const s = total - m * 60;
    if (m > 0) return `${m}:${s.toFixed(2).padStart(5, '0')}`;
    return s.toFixed(2);
}

/**
 * Builds a SwimTime from seconds (HY3 path). Returns null if not a real time.
 * @param {number|null} seconds
 * @returns {SwimTime|null}
 */
export function timeFromSeconds(seconds) {
    if (seconds == null || Number.isNaN(seconds) || seconds <= 0) return null;
    return { text: secondsToText(seconds), seconds: round2(seconds) };
}

/**
 * Builds a SwimTime from display text (SDIF path). Returns null if not a real time.
 * @param {string} text
 * @returns {SwimTime|null}
 */
export function timeFromText(text) {
    const seconds = textToSeconds(text);
    return seconds == null ? null : { text: secondsToText(seconds), seconds };
}

/**
 * Normalizes an MMDDYYYY (or MMDDYY) date to ISO "YYYY-MM-DD".
 * Two-digit years are windowed: <30 → 20xx, else 19xx.
 * @param {string} raw
 * @returns {string|null}
 */
export function normalizeDate(raw) {
    if (!raw) return null;
    const d = String(raw).trim();
    if (d.length === 8) {
        const mm = d.slice(0, 2), dd = d.slice(2, 4), yyyy = d.slice(4, 8);
        if (yyyy === '0000' || mm === '00') return null;
        return `${yyyy}-${mm}-${dd}`;
    }
    if (d.length === 6) {
        const mm = d.slice(0, 2), dd = d.slice(2, 4), yy = parseInt(d.slice(4, 6), 10);
        if (Number.isNaN(yy)) return null;
        const yyyy = yy < 30 ? 2000 + yy : 1900 + yy;
        return `${yyyy}-${mm}-${dd}`;
    }
    return null;
}

/** Rounds to hundredths, avoiding binary-float noise. */
export function round2(n) {
    return Math.round((n + Number.EPSILON) * 100) / 100;
}
