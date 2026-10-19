/**
 * TD Marketing — commission rules (pure; P0, dev job 9aec66fa). Money is in INTEGER CENTS everywhere.
 *
 * Terms are append-only with an effective date. A sale takes a snapshot of the terms in force when its payment link is
 * created, so a later rate change never rewrites a past sale. No terms in force = "terms not set": nothing is computed.
 */

export interface CommissionTerm {
  id: string
  team_id: string
  person_ref: string // 'team' or a user id
  kind: string
  seller_pct: number
  td_pct: number
  basis: "amount_paid" | "net_of_fees"
  payee_account_id: string | null
  effective_from: string // ISO timestamp
}

const toMs = (iso: string) => new Date(iso).getTime()

/**
 * The term in force for (team, kind, person) at `at`. A term for the specific person beats the team-wide one; among the
 * same specificity the latest `effective_from` that has already started wins. Returns null when none applies.
 */
export function termInForce(
  terms: readonly CommissionTerm[],
  q: { teamId: string; kind: string; personRef?: string | null; at: Date },
): CommissionTerm | null {
  const at = q.at.getTime()
  if (!Number.isFinite(at)) return null
  const live = terms.filter(t => t.team_id === q.teamId && t.kind === q.kind && toMs(t.effective_from) <= at)
  const pick = (ref: string) =>
    live.filter(t => t.person_ref === ref).sort((a, b) => toMs(b.effective_from) - toMs(a.effective_from))[0] ?? null
  return (q.personRef ? pick(q.personRef) : null) ?? pick("team")
}

export interface Split {
  sellerCents: number
  tdCents: number
}

/** Seller gets floor(net × pct); the remainder stays with TD, so the two always add up to the net exactly. */
export function splitCents(netCents: number, sellerPct: number): Split | null {
  if (!Number.isInteger(netCents) || netCents < 0) return null
  if (!(sellerPct >= 0 && sellerPct <= 100)) return null
  // pct has at most 2 decimals: scale to basis points so the arithmetic is integer-exact
  const bp = Math.round(sellerPct * 100)
  const sellerCents = Math.floor((netCents * bp) / 10000)
  return { sellerCents, tdCents: netCents - sellerCents }
}

/** The amount the share is computed on: what was paid, or what was left after processor fees, per the term's basis. */
export function shareBase(term: Pick<CommissionTerm, "basis">, paidCents: number, feeCents: number): number | null {
  if (!Number.isInteger(paidCents) || paidCents < 0 || !Number.isInteger(feeCents) || feeCents < 0) return null
  if (term.basis === "amount_paid") return paidCents
  return Math.max(0, paidCents - feeCents)
}
