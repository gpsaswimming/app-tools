#!/usr/bin/env node
/**
 * swimparse CLI — turn .sd3/.hy3 files into NormalizedMeet JSON.
 *
 *   swimparse meet.hy3                     # JSON to stdout
 *   swimparse meet.sd3 -o meet.json        # JSON to a file
 *   swimparse a.sd3 b.hy3 -d out/          # one <name>.json per input, into out/
 *   swimparse meet.hy3 --pretty            # 2-space indented
 *   swimparse meet.hy3 --league gpsa       # DOB-free + census age-groups
 *   swimparse meet.hy3 --league-file x.json# custom league profile
 *   swimparse meet.hy3 --score             # fill GPSA dual-meet points
 *
 * PRIVACY: WITHOUT a league, output contains swimmer birthdates (PII) — do not
 * publish it without sanitizing (see the fixture guardrail). WITH `--league`,
 * birthdates are stripped and age-groups computed, so the output is DOB-free.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { basename, join, extname } from 'node:path';
import { parse } from './src/index.js';
import { score } from './src/score.js';
import { BUILTIN_LEAGUES } from './src/league.js';

function main(argv) {
    const args = argv.slice(2);
    const inputs = [];
    let outFile = null;
    let outDir = null;
    let pretty = false;
    let league = null;
    let doScore = false;

    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === '-o' || a === '--out') outFile = args[++i];
        else if (a === '-d' || a === '--out-dir') outDir = args[++i];
        else if (a === '--pretty') pretty = true;
        else if (a === '--score') doScore = true;
        else if (a === '--league') {
            const name = args[++i];
            league = BUILTIN_LEAGUES[name];
            if (!league) return fail(`unknown league "${name}" (built-in: ${Object.keys(BUILTIN_LEAGUES).join(', ')})`);
        } else if (a === '--league-file') {
            league = JSON.parse(readFileSync(args[++i], 'utf8'));
        } else if (a === '-h' || a === '--help') return help(0);
        else if (a.startsWith('-')) return fail(`unknown option: ${a}`);
        else inputs.push(a);
    }
    if (inputs.length === 0) return help(1);
    if (outFile && inputs.length > 1) return fail('-o takes a single input; use -d for multiple');

    const indent = pretty ? 2 : 0;
    if (outDir) mkdirSync(outDir, { recursive: true });

    for (const file of inputs) {
        const meet = parse(readFileSync(file, 'latin1'), { filename: file, league });
        if (doScore) score(meet); // fill result.points via the GPSA engine (both formats)
        const json = JSON.stringify(meet, null, indent);
        if (outDir) {
            const name = basename(file, extname(file)) + '.json';
            writeFileSync(join(outDir, name), json);
            process.stderr.write(`wrote ${join(outDir, name)} (${meet.format}, ${meet.events.length} events)\n`);
        } else if (outFile) {
            writeFileSync(outFile, json);
            process.stderr.write(`wrote ${outFile} (${meet.format}, ${meet.events.length} events)\n`);
        } else {
            process.stdout.write(json + '\n');
        }
    }
    return 0;
}

function help(codeNum) {
    process.stdout.write(
        'Usage: swimparse <file...> [-o out.json | -d out-dir] [--pretty]\n' +
        '                   [--league <name> | --league-file <path.json>]\n' +
        '  Parses SDIF (.sd3) or Hy-Tek (.hy3) results into NormalizedMeet JSON.\n' +
        `  --league <name>       apply a built-in league profile (${Object.keys(BUILTIN_LEAGUES).join(', ')});\n` +
        '                        computes census age-groups and strips birthdates.\n' +
        '  --league-file <path>  apply a custom league profile (JSON).\n' +
        '  --score               fill GPSA dual-meet points (needed for HY3, which\n' +
        '                        carries none; SDIF points are recomputed to match).\n'
    );
    return codeNum;
}
function fail(msg) {
    process.stderr.write(`swimparse: ${msg}\n`);
    return 2;
}

process.exit(main(process.argv));
