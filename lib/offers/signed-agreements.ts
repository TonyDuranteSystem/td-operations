/**
 * What a signed short contract actually CONTAINS (dev job 0a60f416 — Carasso: one offer for Company Closure + Tax Return was signed with
 * only the Tax Return agreement, and the CRM could only say "tax return" because it named the contract from the offer's single main type).
 *
 * At the moment of signing, the server records the agreements the page printed (`contracts.agreements`, nullable). Everything that names a
 * signed contract reads THAT record first, and falls back to the old "named after the offer's main type" rule when there is none — so a
 * contract signed before this existed keeps the name it always had and is never relabelled by a later change of the switch.
 *
 * Pure: no database, client-safe. The deciding function stays `planAgreements` (lib/offers/standalone-agreement-lines.ts) — the page and the
 * recorder call the same one, so what is recorded is what the client saw.
 */
import { planAgreements } from '@/lib/offers/standalone-agreement-lines'
import { contractLabel, type ContractLabel } from '@/lib/signed-contracts/labels'

export interface SignedAgreement {
  /** the short-contract type of the agreement ("closure", "tax_return", …) */
  type: string
  /** the offer line it was printed for ("Company Closure", "Tax Return 2026") */
  name: string
}

/** The agreements the contract page prints for this offer, in order — the same plan the page draws. */
export function agreementsShownFor(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  offer: any,
  contractType: string,
  multiEnabled: boolean,
): SignedAgreement[] {
  return planAgreements(offer, contractType, multiEnabled).entries.map((e) => ({ type: String(e.type), name: String(e.line?.name ?? '') }))
}

/**
 * Did the page print exactly what the server now plans? `shown` is the list of line names the browser says it printed. Only a real list is
 * compared — a request without one (an old tab open during a deploy) is accepted and recorded from the server's own plan.
 */
export function shownDiffersFromPlan(shown: unknown, planned: SignedAgreement[]): boolean {
  if (!Array.isArray(shown)) return false
  const names = shown.map((s) => String(s))
  if (names.length !== planned.length) return true
  return names.some((n, i) => n !== planned[i].name)
}

/** Read the stored record defensively: anything that is not a list of {type, name} is "no record". */
export function parseSignedAgreements(raw: unknown): SignedAgreement[] | null {
  let value = raw
  if (typeof value === 'string') {
    try { value = JSON.parse(value) } catch { return null }
  }
  if (!Array.isArray(value) || value.length === 0) return null
  const out: SignedAgreement[] = []
  for (const item of value) {
    const type = (item as { type?: unknown })?.type
    const name = (item as { name?: unknown })?.name
    if (typeof type !== 'string' || type.trim() === '') return null
    out.push({ type, name: typeof name === 'string' ? name : '' })
  }
  return out
}

/**
 * The name a signed contract carries on the company page and the contact card, from what it contains.
 * null = there is no record of what it contains, so the caller keeps the old name.
 */
export function signedAgreementsLabel(raw: unknown): ContractLabel | null {
  const list = parseSignedAgreements(raw)
  if (!list) return null
  if (list.length === 1) return contractLabel(list[0].type, null)
  const chips: string[] = []
  for (const a of list) {
    const chip = contractLabel(a.type, null).chip
    if (!chips.includes(chip)) chips.push(chip)
  }
  const joined = chips.join(' + ')
  return { chip: joined, title: `${joined} agreements` }
}
