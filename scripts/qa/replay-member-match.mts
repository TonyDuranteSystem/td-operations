/* eslint-disable no-console -- CLI gate; console output IS the product */
/**
 * Replay the MEMBER-MATCH rule over every real production row that could be
 * affected by it, comparing the OLD behaviour against the NEW one.
 *
 * Sampling is not enough for a money rule. The own-entity change (2026-08-03)
 * passed every hand-picked test and still had a false positive that only a full
 * replay caught, and the first cut of THIS change silently dropped company
 * members ("B&P International LLC") — found by a test, not by reading the code.
 *
 * WHAT COUNTS AS "COULD BE AFFECTED": every row whose text contains a SURNAME
 * of one of its own account's members. Both paths that can move a row need the
 * surname — an exact full-name match contains it, and the near-miss check keys
 * on it — so a row without one provably cannot change. That reduces 19,463 rows
 * to a few hundred, exhaustively.
 *
 * OLD behaviour (what production does today): lowercase substring test over
 * description and counterparty, roster = linked contacts with a >= 5 character
 * name.
 * NEW behaviour: accent-folded whole-word match, roster = curated members
 * UNIONed with linked contacts under the usable-name rule, plus the near-miss
 * demotion that sends a genuinely uncertain payment to the client.
 *
 * Input: JSON array of {acct, co, d, c, out, cat, sub, note, n} plus a roster
 * map {acct: [names]}. Pass the export path as argv[2] and the roster path as
 * argv[3].
 */
import { readFileSync } from 'fs'
import { matchMemberName, findNearMissMember, filterMemberNames } from '../../lib/tax/member-names'

type Row = { acct: string; co: string; d: string; c: string; out: boolean; cat: string; sub: string; note: string; n: number }

const rows: Row[] = JSON.parse(readFileSync(process.argv[2], 'utf8'))
const rosters: Record<string, string[]> = JSON.parse(readFileSync(process.argv[3], 'utf8'))

/** The rule exactly as production runs it today. */
function oldMatch(text: string, names: string[]): string | null {
  const hay = text.toLowerCase()
  for (const n of names) {
    const ln = n.toLowerCase()
    if (ln.length >= 5 && hay.includes(ln)) return n
  }
  return null
}

const GUESSED = new Set(['uncategorized', 'expense', 'fee'])

let same = 0
const newlyFound: Row[] = []   // NEW finds a member the old rule missed
const lost: Row[] = []         // OLD found a member the new rule does not
const asked: Row[] = []        // NEW sends it to the client as a question
const manualSkipped: Row[] = []

for (const r of rows) {
  // A human answer is never touched by any of this — the engine refuses rows
  // carrying a "manual:" note before the matcher is ever consulted.
  if (r.note.startsWith('manual:')) { manualSkipped.push(r); continue }

  const roster = filterMemberNames(rosters[r.acct] ?? [])
  const text = `${r.d} ${r.c}`

  const before = oldMatch(text, rosters[r.acct] ?? [])
  const after = matchMemberName(text, roster)

  if (before && after) { same++; continue }
  if (!before && after) { newlyFound.push(r); continue }
  if (before && !after) { lost.push(r); continue }

  // Neither matched. Does the new near-miss rule turn it into a question?
  if (r.out && GUESSED.has(r.cat) && findNearMissMember(text, roster)) asked.push(r)
  else same++
}

const tx = (list: Row[]) => list.reduce((a, r) => a + r.n, 0)
console.log(`INPUT: ${rows.length} at-risk rows (${tx(rows)} transactions incl. duplicates)`)
console.log(`UNCHANGED: ${same}`)
console.log(`SKIPPED (human already answered): ${manualSkipped.length}`)
console.log(`\nNEWLY DETECTED as a member (was being missed): ${newlyFound.length}`)
for (const r of newlyFound) console.log(`   + ${r.co} | ${r.cat}/${r.sub} | ${r.d.slice(0, 72)}`)
console.log(`\nNO LONGER detected as a member — REVIEW EVERY ONE: ${lost.length}`)
for (const r of lost) console.log(`   - ${r.co} | ${r.cat}/${r.sub} | ${r.d.slice(0, 72)}`)
console.log(`\nSENT TO THE CLIENT as a question (uncertain): ${asked.length}`)
for (const r of asked) console.log(`   ? ${r.co} | was ${r.cat}/${r.sub} | ${r.d.slice(0, 72)}`)
