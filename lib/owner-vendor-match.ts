/**
 * Vendor matching for the owner's books — PURE and CLIENT-SAFE (no DB imports).
 * Lives in its own file because the transactions tab (a client component) needs these
 * at render time for rule suggestions; importing them from the server-side books module
 * would pull the service-role client into the browser bundle.
 */

/**
 * Vendor identity for "transactions like this": lowercase, punctuation → spaces,
 * whitespace collapsed. Banks word the SAME counterparty differently
 * ("STRIPE - TRANSFER" vs "STRIPE; TRANSFER; TONY DURANTE LLC; …"), so raw string
 * equality misses half of a vendor's rows; normalized containment catches them.
 */
export function normalizeVendorKey(s: string | null | undefined): string {
  return (s ?? '')
    .normalize('NFD')
    // Fold accents BEFORE stripping non-alphanumerics: 'CAFFÈ' must become 'caffe',
    // not 'caff' — a truncated key false-groups unrelated caff* vendors.
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
}

/** Whole-token containment: every token of the shorter side appears as a WHOLE token of
 * the longer side, in order. Raw substring matching is a trap — "chase" is inside
 * "purchase", and "POS PURCHASE" wording is everywhere in bank feeds. */
function containsAsTokens(longer: string, shorter: string): boolean {
  return ` ${longer} `.includes(` ${shorter} `)
}

/** Loose same-vendor test: normalized equality, or whole-token containment when the
 * shorter side is substantial (≥4 chars — "a" must not match everything). */
export function isSimilarVendor(a: string | null | undefined, b: string | null | undefined): boolean {
  const na = normalizeVendorKey(a)
  const nb = normalizeVendorKey(b)
  if (!na || !nb) return false
  if (na === nb) return true
  const shorter = na.length <= nb.length ? na : nb
  const longer = na.length <= nb.length ? nb : na
  return shorter.length >= 4 && containsAsTokens(longer, shorter)
}

export interface VendorRule {
  id: string
  counterparty_pattern: string
  match_type: 'exact' | 'contains' | 'regex'
  category: string
  subcategory: string
  is_related_party: boolean
  notes: string | null
}

/** The rule-application shape shared by suggestions (client) and any future sweep-time
 * suggestion pass (server). Only ever touches rows still 'uncategorized'. */
export function applyVendorRulesTo<T extends {
  category: string
  subcategory: string | null
  counterparty: string | null
  description: string
  is_related_party: boolean
}>(transactions: T[], rules: VendorRule[]): T[] {
  // Most-specific rule wins: with both "stripe" and "stripe fee" saved, a STRIPE FEE row
  // must hit the narrower rule — alphabetical/first-found order would let the broad one
  // shadow it and book a fee as a transfer.
  const ordered = [...rules].sort((a, z) =>
    normalizeVendorKey(z.counterparty_pattern).length - normalizeVendorKey(a.counterparty_pattern).length
  )

  return transactions.map(tx => {
    if (tx.category !== 'uncategorized') return tx

    const counterparty = (tx.counterparty ?? tx.description ?? '').toLowerCase()
    const matched = ordered.find(rule => {
      const pattern = rule.counterparty_pattern.toLowerCase()
      if (rule.match_type === 'exact') return counterparty === pattern
      // Normalized whole-token match on BOTH sides: a saved "stripe transfer" rule must
      // match the semicolon-worded Mercury variant too — but a "chase" rule must NOT
      // match "POS PURCHASE" wording (token boundaries, not raw substring). An empty
      // normalized pattern would match everything — treat it as matching nothing.
      if (rule.match_type === 'contains') {
        const np = normalizeVendorKey(pattern)
        return np !== '' && containsAsTokens(normalizeVendorKey(counterparty), np)
      }
      if (rule.match_type === 'regex') {
        try { return new RegExp(pattern, 'i').test(counterparty) } catch { return false }
      }
      return false
    })

    if (!matched) return tx
    return {
      ...tx,
      category: matched.category,
      subcategory: matched.subcategory,
      is_related_party: matched.is_related_party,
    }
  })
}
