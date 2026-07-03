# Test fixtures — synthetic, safe to commit

`gg-at-ww.sd3` and `gg-at-ww.hy3` are the **same GPSA dual meet** exported in the
two supported formats (SDIF v3 and Hy-Tek), used by `golden.test.js` to prove the
two adapters agree swim-for-swim.

## These contain NO real swimmer data

They were derived from a real meet file, but **every swimmer identity was replaced
with a public figure** (Einstein, Curie, Ledecky, …). For each swimmer:

- name → a public figure of the same sex,
- birth **year** → shifted so the figure's GPSA league age (as of June 1) matches
  the age group that swimmer competes in (month/day are the figure's real-ish
  birthday),
- USA-S ID / registration codes → regenerated from the fake name + date.

Everything else — times, places, DQs and reasons, event structure, relay legs — is
preserved exactly, so the files remain a faithful parser test. The generator
verifies that no real surname survives in any name field.

## Golden snapshots

`*.golden.json` are the expected `NormalizedMeet` outputs. Regenerate them only
when a parser change is intentional:

```bash
node -e "import('../src/index.js').then(async m=>{const {readFileSync,writeFileSync}=await import('node:fs');
for(const f of ['gg-at-ww.sd3','gg-at-ww.hy3']){
  const meet=m.parse(readFileSync(f,'latin1'),{filename:f});
  writeFileSync(f+'.golden.json', JSON.stringify(meet,null,2));}})"
```

Then review the diff and run `node --test`.
