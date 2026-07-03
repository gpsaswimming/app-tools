/**
 * Format detection. Prefers content sniffing over file extension, since both
 * formats are plain text and extensions are sometimes wrong.
 */

/**
 * @param {string} content
 * @param {string} [filename] optional, used only as a tie-breaker
 * @returns {'sdif-v3'|'hy3'|null}
 */
export function detectFormat(content, filename) {
    const firstLines = String(content).split(/\r?\n/, 5);
    for (const line of firstLines) {
        const code = line.slice(0, 2);
        // HY3 files open with an A1 file-description record.
        if (code === 'A1') return 'hy3';
        // SDIF v3 files open with an A0 file record (or at least carry B1).
        if (code === 'A0' || code === 'B1') return 'sdif-v3';
    }
    if (firstLines.some((l) => l.startsWith('B11') || l.startsWith('D0') || l.startsWith('D3'))) return 'sdif-v3';
    if (firstLines.some((l) => l.startsWith('D1') || l.startsWith('E1'))) return 'hy3';

    if (filename) {
        const ext = filename.toLowerCase().split('.').pop();
        if (ext === 'hy3') return 'hy3';
        if (ext === 'sd3' || ext === 'cl2' || ext === 'txt') return 'sdif-v3';
    }
    return null;
}
