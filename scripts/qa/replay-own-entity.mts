/* eslint-disable no-console -- CLI gate; console output IS the product */
/**
 * Replay the own-entity self-transfer rule over EVERY real production row.
 *
 * Sampling is not enough for a money rule (2026-08-03): the first cut of the
 * outgoing fix passed every hand-picked test and still had a false positive —
 * Dynamiq's genuine Mercury→Relay move — which only this replay caught.
 *
 * Input: a JSON array of {own, cp, descr, outgoing, n, total, was_fixed_by_me}
 * exported from production. Pass the path as argv[2].
 */
import { readFileSync } from 'fs'
import { detectOwnEntityTransfers } from '../../lib/tax/transfer-matcher'

type Shape = { own: string; cp: string; descr: string; outgoing: boolean; n: number; total: number; was_fixed_by_me: boolean }
const shapes: Shape[] = JSON.parse(readFileSync(process.argv[2], 'utf8'))

let keptTx = 0, releasedTx = 0
const released: Shape[] = []
for (const s of shapes) {
  const hits = detectOwnEntityTransfers(
    [{ id: 'x', category: 'uncategorized', counterparty: s.cp, description: s.descr,
       amount: s.outgoing ? -Math.abs(s.total || 1) : Math.abs(s.total || 1) }],
    { ownNames: [s.own] },
  )
  if (hits.length) keptTx += s.n
  else { releasedTx += s.n; released.push(s) }
}

console.log(`INPUT: ${shapes.length} shapes / ${shapes.reduce((a, s) => a + s.n, 0)} transactions`)
console.log(`KEPT auto-hidden: ${keptTx}   RELEASED to the client: ${releasedTx}`)
const mine = released.filter(r => r.was_fixed_by_me).reduce((a, r) => a + r.n, 0)
console.log(`  of released, already judged wrong by hand: ${mine}`)
console.log(`  NEW (not previously judged wrong): ${releasedTx - mine}`)
for (const r of released.sort((a, b) => Number(a.total) - Number(b.total))) {
  console.log(`   ${r.was_fixed_by_me ? 'known' : 'NEW  '} | ${r.own} | ${r.n}x | ${Number(r.total).toFixed(2)} | ${r.descr.slice(0, 70)}`)
}
