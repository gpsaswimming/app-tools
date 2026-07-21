/**
 * GPSA Publicity Core Module
 * Shared parsing and generation logic for SDIF meet results.
 *
 * Used by:
 * - tools/publicity.html (browser)
 * - publicity-server/server.mjs (Node.js API)
 */

// =============================================================================
// Constants
// =============================================================================

export const VERSION = '1.2';

export const LOGO_URL = 'https://assets.gpsaswimming.org/img/gpsa_logo.png';

export const STROKE_MAP = {
    '1': 'Freestyle',
    '2': 'Backstroke',
    '3': 'Breaststroke',
    '4': 'Butterfly',
    '5': 'IM',
    '6': 'Freestyle Relay',
    '7': 'Medley Relay'
};

export const GENDER_MAP = {
    'M': 'Boys',
    'F': 'Girls',
    'X': 'Mixed'
};

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Escapes HTML special characters to prevent XSS.
 * Uses regex replacement for Node.js compatibility (no DOM required).
 *
 * @param {string} text - The text to escape
 * @returns {string} The escaped text
 */
export function escapeHtml(text) {
    if (!text) return '';
    const htmlEscapes = {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
    };
    return String(text).replace(/[&<>"']/g, char => htmlEscapes[char]);
}

/**
 * Renders a swim time for display, showing "NT" (No Time) when none was recorded.
 *
 * A blank time is legitimate: when a timing issue leaves a swimmer or heat with no
 * usable time and no backup, the scorekeeper clears the time in Meet Maestro (there
 * is no "NT" code to type), which exports as an empty time field. The swim still
 * placed — GPSA scores by place — so it must publish as "NT", not an empty cell.
 *
 * @param {string} time - Trimmed time from the SDIF final-time field
 * @returns {string} The time, or "NT" if it is blank
 */
export function displayTime(time) {
    return time && time.trim() ? time : 'NT';
}

/**
 * Parses SDIF age code into human-readable format.
 *
 * @param {string} ageCode - 4-character age code (e.g., "0810" for 8-10)
 * @returns {string} Human-readable age group (e.g., "8-10", "10 & Under", "Open")
 */
export function parseAgeCode(ageCode) {
    if (!ageCode || ageCode.length < 4) return 'Open';

    const lowerStr = ageCode.substring(0, 2);
    const upperStr = ageCode.substring(2, 4);

    if (lowerStr === 'UN' && upperStr === 'OV') return 'Open';

    if (lowerStr === 'UN') {
        const upperAge = parseInt(upperStr, 10);
        return isNaN(upperAge) ? 'Open' : `${upperAge} & Under`;
    }

    if (upperStr === 'OV') {
        const lowerAge = parseInt(lowerStr, 10);
        return isNaN(lowerAge) ? 'Open' : `${lowerAge} & Over`;
    }

    const lowerAge = parseInt(lowerStr, 10);
    const upperAge = parseInt(upperStr, 10);

    if (isNaN(lowerAge) || isNaN(upperAge)) return 'Open';

    if (lowerAge === upperAge) return `${lowerAge}`;

    return `${lowerAge}-${upperAge}`;
}

// =============================================================================
// SDIF Parsing
// =============================================================================

/**
 * Validates SDIF data by checking for required B1 record.
 *
 * @param {string} data - Raw SDIF file content
 * @returns {{ valid: boolean, error?: string }} Validation result
 */
export function validateSdif(data) {
    if (!data || typeof data !== 'string') {
        return { valid: false, error: 'No data provided' };
    }

    const lines = data.split(/[\r\n]+/);
    const hasB1 = lines.some(line => line.substring(0, 2) === 'B1');

    if (!hasB1) {
        return { valid: false, error: 'Invalid SDIF format: Missing B1 (Meet) record' };
    }

    return { valid: true };
}

/**
 * Validates that parsed meet data represents a dual meet (exactly 2 teams).
 * This tool is designed for GPSA league dual meets only.
 *
 * @param {object} parsedData - Parsed meet data from parseSdif()
 * @returns {{ valid: boolean, error?: string }} Validation result
 */
export function validateDualMeet(parsedData) {
    const teamCount = Object.keys(parsedData.teams).length;

    if (teamCount === 0) {
        return { valid: false, error: 'No teams found in the meet file. This tool requires a dual meet with exactly 2 teams.' };
    }

    if (teamCount === 1) {
        const teamName = Object.values(parsedData.teams)[0]?.name || 'Unknown';
        return { valid: false, error: `Only 1 team found (${teamName}). This tool is designed for dual meets between 2 teams.` };
    }

    if (teamCount > 2) {
        return { valid: false, error: `${teamCount} teams found. This tool is designed for dual meets between exactly 2 teams. For invitationals or multi-team meets, use a different processor.` };
    }

    return { valid: true };
}

/**
 * Parses SDIF file content into structured meet data.
 *
 * @param {string} data - Raw SDIF file content
 * @returns {{ meet: object, teams: object, events: object }} Parsed meet data
 */
export function parseSdif(data) {
    const lines = data.split(/[\r\n]+/);
    const meet = {};
    const teams = {};
    const events = {};

    let currentTeamCode = null;
    let lastRelayResult = null;

    function createEventObject(line, type) {
        const genderCode = type === 'Individual' ? line.substring(66, 67) : line.substring(20, 21);
        const ageCode = type === 'Individual' ? line.substring(76, 80) : line.substring(30, 34);
        const distance = type === 'Individual' ? line.substring(67, 71).trim() : line.substring(21, 25).trim();
        const strokeCode = type === 'Individual' ? line.substring(71, 72) : line.substring(25, 26);
        const gender = GENDER_MAP[genderCode] || 'Unknown';
        let age = parseAgeCode(ageCode);

        // For relays, if the age group is 'Open', don't include it in the description to save space.
        if (type === 'Relay' && age === 'Open') {
            age = '';
        }

        return {
            description: `${gender} ${age} ${distance}m ${STROKE_MAP[strokeCode] || `Stroke ${strokeCode}`}`.replace(/\s+/g, ' ').trim(),
            results: [],
            type
        };
    }

    lines.forEach(line => {
        const code = line.substring(0, 2);
        try {
            switch (code) {
                case 'B1':
                    meet.name = line.substring(11, 41).trim();
                    meet.startDate = line.substring(121, 129).trim(); // MMDDYYYY
                    lastRelayResult = null;
                    break;
                case 'B2': // Capture Host Team Name
                    if (!meet.hostName) { // Only capture the first host listed
                        meet.hostName = line.substring(11, 41).trim();
                    }
                    break;
                case 'C1':
                    const rawTeamCode = line.substring(11, 17).trim();
                    const teamName = line.substring(17, 47).trim();
                    currentTeamCode = rawTeamCode;
                    if (!teams[rawTeamCode]) {
                        let displayCode = rawTeamCode;
                        if (displayCode.startsWith('VA')) {
                            displayCode = displayCode.substring(2);
                        }
                        teams[rawTeamCode] = { name: teamName, score: 0, code: displayCode };
                    }
                    lastRelayResult = null;
                    break;
                case 'D0':
                    lastRelayResult = null;
                    const eventNumD0 = line.substring(72, 76).trim();
                    if (eventNumD0 && eventNumD0 !== '0') {
                        const swimmerName = line.substring(11, 39).trim();
                        const finalTime = line.substring(115, 123).trim();
                        const place = parseInt(line.substring(135, 138).trim(), 10);
                        const points = parseFloat(line.substring(138, 142).trim()) || 0;
                        if (!events[eventNumD0]) {
                            events[eventNumD0] = createEventObject(line, 'Individual');
                        }
                        if (place && currentTeamCode) {
                            events[eventNumD0].results.push({
                                place,
                                swimmer: swimmerName,
                                teamCode: teams[currentTeamCode]?.code,
                                time: finalTime,
                                points
                            });
                            if (teams[currentTeamCode]) {
                                teams[currentTeamCode].score += points;
                            }
                        }
                    }
                    break;
                case 'E0':
                    const eventNumE0 = line.substring(26, 30).trim();
                    if (eventNumE0 && eventNumE0 !== '0') {
                        const relayTeamChar = line.substring(11, 12).trim();
                        const relayFinalTime = line.substring(72, 80).trim();
                        const relayPlace = parseInt(line.substring(92, 95).trim(), 10);
                        const relayPoints = parseFloat(line.substring(95, 99).trim()) || 0;
                        if (!events[eventNumE0]) {
                            events[eventNumE0] = createEventObject(line, 'Relay');
                        }
                        if (relayPlace && currentTeamCode) {
                            const relayResultObject = {
                                place: relayPlace,
                                swimmer: `${teams[currentTeamCode]?.name || currentTeamCode} '${relayTeamChar}'`,
                                teamCode: teams[currentTeamCode]?.code,
                                time: relayFinalTime,
                                points: relayPoints,
                                swimmers: []
                            };
                            events[eventNumE0].results.push(relayResultObject);
                            lastRelayResult = relayResultObject;
                            if (teams[currentTeamCode]) {
                                teams[currentTeamCode].score += relayPoints;
                            }
                        } else {
                            lastRelayResult = null;
                        }
                    }
                    break;
                case 'F0':
                    if (lastRelayResult) {
                        const swimmerName = line.substring(22, 50).trim();
                        if (swimmerName) {
                            lastRelayResult.swimmers.push(swimmerName);
                        }
                    }
                    break;
            }
        } catch (e) {
            // Silently skip malformed lines
            console.error(`Error parsing line: ${line}`, e);
        }
    });

    // Generate meet title from host and away team names
    const teamList = Object.values(teams);
    if (meet.hostName && meet.startDate && teamList.length === 2) {
        const year = meet.startDate.substring(4);
        const awayTeam = teamList.find(team => team.name !== meet.hostName);
        if (awayTeam) {
            meet.name = `${year} ${meet.hostName} v. ${awayTeam.name}`;
        }
    }

    // Sort results by place
    Object.values(events).forEach(event => {
        event.results.sort((a, b) => a.place - b.place);
    });

    return { meet, teams, events };
}

// =============================================================================
// Data-quality audit
// =============================================================================

// GPSA place → points (index 0 = 1st). Unlisted places score 0. Kept local to
// this tool for now; the swimparse engine holds the same values in league config.
const PLACE_POINTS = { Individual: [5, 3, 1], Relay: [7] };

/**
 * Flags results whose recorded PLACE disagrees with the points they were
 * awarded — the fingerprint of a DQ / exhibition that wasn't reconciled in the
 * place order (e.g. a 2nd-place label kept while the swim earned 1st-place
 * points because the swimmer ahead was disqualified). It changes nothing; it
 * just hands the mismatch to the rep to review before publishing.
 *
 * @param {object} data - Parsed meet data from parseSdif()
 * @returns {Array<{eventNumber:string, eventDescription:string, swimmer:string,
 *   teamCode:string, place:number, points:number, expectedPoints:number}>}
 */
export function auditPlacePoints(data) {
    const issues = [];
    Object.keys(data.events)
        .sort((a, b) => parseInt(a, 10) - parseInt(b, 10))
        .forEach((eventNumber) => {
            const event = data.events[eventNumber];
            const table = PLACE_POINTS[event.type] || [];
            event.results.forEach((r) => {
                const expectedPoints = table[r.place - 1] || 0;
                if (r.points !== expectedPoints) {
                    issues.push({
                        eventNumber,
                        eventDescription: event.description,
                        swimmer: r.swimmer,
                        teamCode: r.teamCode,
                        place: r.place,
                        points: r.points,
                        expectedPoints,
                    });
                }
            });
        });
    return issues;
}

// =============================================================================
// Override/Forfeit Functions
// =============================================================================

/**
 * Applies forfeit scores to parsed meet data.
 * Winner gets 1.0, loser gets 0.0.
 *
 * @param {object} data - Parsed meet data from parseSdif()
 * @param {object} overrideData - Override configuration
 * @param {string} overrideData.winnerCode - Team code of the winning team
 * @param {string} overrideData.loserCode - Team code of the losing team
 * @returns {object} Modified meet data with forfeit scores applied
 */
export function applyForfeitScores(data, overrideData) {
    if (!overrideData) return data;

    // Apply forfeit scores: Winner = 1.0, Loser = 0.0
    Object.values(data.teams).forEach(team => {
        if (team.code === overrideData.winnerCode) {
            team.score = 1.0;
        } else if (team.code === overrideData.loserCode) {
            team.score = 0.0;
        }
    });

    return data;
}

// =============================================================================
// Filename Generation
// =============================================================================

/**
 * Generates a standardized filename for exported results.
 * Format: YYYY-MM-DD_TEAM1_v_TEAM2.html (for dual meets)
 *
 * @param {object} parsedData - Parsed meet data from parseSdif()
 * @returns {string} Generated filename
 */
export function generateFilename(parsedData) {
    const { meet, teams } = parsedData;
    const meetDate = meet.startDate;
    const teamList = Object.values(teams);

    // Create specific filename for dual meets
    if (meetDate && meetDate.length === 8 && teamList.length === 2) {
        const year = meetDate.substring(4);
        const month = meetDate.substring(0, 2);
        const day = meetDate.substring(2, 4);
        const formattedDate = `${year}-${month}-${day}`;

        const team1Code = teamList[0].code;
        const team2Code = teamList[1].code;

        return `${formattedDate}_${team1Code}_v_${team2Code}.html`;
    }

    // Default filename
    return `${meet.name.replace(/ /g, '_')}_Results.html`;
}

// =============================================================================
// HTML Generation
// =============================================================================

/**
 * Generates a standalone HTML document with meet results.
 *
 * @param {object} data - Parsed meet data from parseSdif()
 * @param {string} logoUrl - URL for the header logo
 * @param {object} [overrideData] - Optional override data for forfeit display
 * @param {string} [overrideData.winnerName] - Name of the winning team
 * @param {string} [overrideData.reason] - Reason for the override
 * @returns {string} Complete HTML document as a string
 */
export function generateExportableHtml(data, logoUrl, overrideData = null) {
    const { meet, teams, events } = data;

    // Extract winners
    const winners = [];
    Object.keys(events).sort((a, b) => parseInt(a) - parseInt(b)).forEach(eventNum => {
        const event = events[eventNum];
        const winner = event.results.find(r => r.place === 1);
        if (winner) {
            winners.push({ eventNum, description: event.description, winnerData: winner, type: event.type });
        }
    });

    // Generate winners table rows
    const winnersRows = winners.map(w => {
        const result = w.winnerData;
        const winnerCellContent = (w.type === 'Relay' && result.swimmers?.length)
            ? result.swimmers.join('<br>')
            : result.swimmer;
        return `<tr><td class="center">${w.eventNum}</td><td>${w.description}</td><td>${winnerCellContent}</td><td class="center">${result.teamCode || ''}</td><td class="center">${displayTime(result.time)}</td></tr>`;
    }).join('');

    // Generate scores table rows
    const sortedTeams = Object.values(teams).sort((a, b) => b.score - a.score);
    const scoresRows = sortedTeams.map(team => `<tr><td>${team.name}</td><td>${team.score.toFixed(1)}</td></tr>`).join('');

    // Generate override banner if applicable
    const overrideBanner = overrideData ? `
            <div style="background-color: #fefce8; border-left: 4px solid #facc15; padding: 1rem; margin-bottom: 1.5rem; border-radius: 0.375rem;">
                <p style="color: #854d0e; font-size: 0.875rem; line-height: 1.5;">
                    <strong style="font-weight: 700;">&#x26A0;&#xFE0F; MEET RESULTS OVERRIDDEN</strong><br>
                    <strong>Winner:</strong> ${escapeHtml(overrideData.winnerName)}<br>
                    <strong>Reason:</strong> ${escapeHtml(overrideData.reason)}
                </p>
            </div>
            ` : '';

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${meet.name || 'Swim Meet Results'}</title>

    <!-- Google Fonts -->
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">

    <!-- Favicon Links -->
    <link rel="apple-touch-icon" sizes="180x180" href="https://assets.gpsaswimming.org/img/favicons/apple-touch-icon.png">
    <link rel="icon" type="image/png" sizes="32x32" href="https://assets.gpsaswimming.org/img/favicons/favicon-32x32.png">
    <link rel="icon" type="image/png" sizes="16x16" href="https://assets.gpsaswimming.org/img/favicons/favicon-16x16.png">
    <link rel="mask-icon" href="https://assets.gpsaswimming.org/img/favicons/safari-pinned-tab.svg" color="#002366">
    <meta name="msapplication-TileColor" content="#002366">
    <meta name="theme-color" content="#002366">

    <style>
        /* Base Styles */
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }

        body {
            font-family: 'Inter', -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
            line-height: 1.6;
            color: #1f2937;
            background-color: #f0f2f5;
            padding: 1rem;
        }

        .container {
            max-width: 1280px;
            margin: 0 auto;
            padding: 1.5rem;
            background-color: #fff;
            box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06);
            border-radius: 0.75rem;
        }

        /* Header Styles */
        header {
            background-color: #002366;
            color: white;
            padding: 2rem;
            text-align: center;
            border-radius: 0.75rem 0.75rem 0 0;
            margin: -1.5rem -1.5rem 2rem -1.5rem;
        }

        header img {
            width: 80px;
            height: 80px;
            margin-bottom: 1rem;
            border-radius: 50%;
            object-fit: cover;
        }

        header h1 {
            font-size: 2rem;
            font-weight: 700;
            color: white;
            margin: 0;
        }

        /* Typography */
        h2 {
            color: #002366;
            font-size: 1.875rem;
            font-weight: 700;
            text-align: center;
            margin-top: 2.5rem;
            margin-bottom: 1.5rem;
            padding-bottom: 0.75rem;
            border-bottom: 3px solid #d9242b;
        }

        h2:first-of-type {
            margin-top: 0;
        }

        /* Table Styles */
        .table-wrapper {
            overflow-x: auto;
            margin-bottom: 2rem;
        }

        .table-wrapper.narrow {
            max-width: 900px;
            margin-left: auto;
            margin-right: auto;
        }

        table {
            width: 100%;
            border-collapse: collapse;
            font-size: 0.875rem;
        }

        th, td {
            padding: 0.75rem 1rem;
            text-align: left;
            vertical-align: top;
            border: 1px solid #e5e7eb;
        }

        /* Center-aligned columns */
        .center {
            text-align: center;
        }

        thead {
            background-color: #002366;
            color: white;
        }

        thead th {
            font-weight: 600;
            text-transform: uppercase;
            font-size: 0.75rem;
            letter-spacing: 0.05em;
        }

        tbody tr {
            background-color: #ffffff;
        }

        tbody tr:nth-child(odd) {
            background-color: #f9fafb;
        }

        tbody tr:hover {
            background-color: #f3f4f6;
        }

        tbody td {
            color: #374151;
        }

        tbody td:first-child {
            font-weight: 500;
            color: #1f2937;
        }

        /* Footer Styles */
        footer {
            text-align: center;
            margin-top: 3rem;
            padding-top: 2rem;
            border-top: 1px solid #e5e7eb;
            font-size: 0.875rem;
            color: #6b7280;
        }

        /* Print Styles */
        @media print {
            body {
                background-color: white;
                padding: 0;
            }

            .container {
                box-shadow: none;
                padding: 0;
                max-width: 100%;
            }

            header {
                margin: 0 0 2rem 0;
            }
        }

        /* Responsive Styles */
        @media (max-width: 768px) {
            body {
                padding: 0.5rem;
            }

            .container {
                padding: 1rem;
                border-radius: 0.5rem;
            }

            header {
                padding: 1.5rem 1rem;
                margin: -1rem -1rem 1.5rem -1rem;
            }

            header img {
                width: 64px;
                height: 64px;
            }

            header h1 {
                font-size: 1.5rem;
            }

            h2 {
                font-size: 1.5rem;
                margin-top: 2rem;
            }

            table {
                font-size: 0.75rem;
            }

            th, td {
                padding: 0.5rem;
            }

            thead th {
                font-size: 0.625rem;
            }
        }

        @media (min-width: 769px) and (max-width: 1024px) {
            header h1 {
                font-size: 1.875rem;
            }
        }

        @media (min-width: 1025px) {
            header img {
                width: 100px;
                height: 100px;
            }

            header h1 {
                font-size: 2.25rem;
            }
        }
    </style>
</head>
<body>
    <div class="container">
        <header>
            <img src="${logoUrl}" alt="GPSA Logo" onerror="this.onerror=null; this.src='https://placehold.co/100x100/002366/FFFFFF?text=GPSA';">
            <h1>${meet.name || 'Swim Meet Results'}</h1>
        </header>

        <main>
            ${overrideBanner}
            <h2>Team Scores</h2>
            <div class="table-wrapper narrow">
                <table>
                    <thead>
                        <tr>
                            <th>Team</th>
                            <th>Score</th>
                        </tr>
                    </thead>
                    <tbody>${scoresRows}</tbody>
                </table>
            </div>

            <h2>Event Winners</h2>
            <div class="table-wrapper">
                <table>
                    <thead>
                        <tr>
                            <th class="center">Event</th>
                            <th>Description</th>
                            <th>Winner(s)</th>
                            <th class="center">Team</th>
                            <th class="center">Time</th>
                        </tr>
                    </thead>
                    <tbody>${winnersRows}</tbody>
                </table>
            </div>
        </main>

        <footer>
            <p>Results generated on ${new Date().toLocaleDateString()} with the GPSA Meet Publicity Tool v${VERSION}</p>
        </footer>
    </div>
</body>
</html>`;
}

// =============================================================================
// Metadata Extraction
// =============================================================================

/**
 * Extracts metadata from parsed meet data for API responses.
 *
 * @param {object} parsedData - Parsed meet data from parseSdif()
 * @returns {object} Metadata object with meet info, teams, and event count
 */
export function extractMetadata(parsedData) {
    const { meet, teams, events } = parsedData;
    const teamList = Object.values(teams).map(t => ({
        code: t.code,
        name: t.name,
        score: t.score
    })).sort((a, b) => b.score - a.score);

    // Format date if available
    let meetDate = null;
    let meetYear = null;
    if (meet.startDate && meet.startDate.length === 8) {
        const year = meet.startDate.substring(4);
        const month = meet.startDate.substring(0, 2);
        const day = meet.startDate.substring(2, 4);
        meetDate = `${year}-${month}-${day}`;
        meetYear = year;
    }

    return {
        meetName: meet.name || 'Unknown Meet',
        meetDate,
        meetYear,
        teams: teamList,
        eventCount: Object.keys(events).length
    };
}
