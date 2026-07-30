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

/** The owner entity's own name in bank wordings — SENDER noise, not vendor identity.
 * Mercury puts the SENDER in the counterparty field for outgoing payments and hides the
 * real recipient in "Merchant name: X" — by counterparty alone, a $2,500 payment to a
 * vendor looked IDENTICAL to an own-account transfer (Antonio's live catch, 2026-07-29).
 * Includes the 'Durant' misspelling that appears in real Mercury data. Multi-entity
 * later: derive from the entity record instead of a constant. */
const OWN_ENTITY_KEYS = ["tony durante llc", "tony durant llc"]

/**
 * The string that IDENTIFIES the vendor for matching/grouping:
 * 1. a "Merchant name: X" marker in the description wins — it is the bank's structured
 *    merchant field, flattened into text at projection time;
 * 2. else the counterparty (fallback description) with the own-entity name stripped —
 *    "Acme — From Tony Durante LLC" must group by "acme", never by the sender;
 * 3. a string that consists ONLY of the own name (a genuine self-transfer) keeps it,
 *    so own-account transfers still group with each other.
 */
export function vendorIdentity(counterparty: string | null | undefined, description: string | null | undefined): string {
  // The marker can sit in EITHER field — Mercury flattens it into whichever the
  // projection kept.
  const merchant = ((description ?? "").match(/merchant name:\s*([^;|]+)/i) ?? (counterparty ?? "").match(/merchant name:\s*([^;|]+)/i))?.[1]?.trim()
  const base = counterparty || description || ""
  let key = normalizeVendorKey(merchant || base)
  if (merchant && OWN_ENTITY_KEYS.includes(key)) {
    // The "merchant" is the own name too (self-transfer worded with a marker) — keep it.
    return key
  }
  if (!merchant) {
    // Strip EVERY occurrence of the own name (self-transfer wordings repeat it), the
    // Mercury transport boilerplate, and dangling "from" sender markers — all wiring,
    // none of it vendor identity.
    for (const own of OWN_ENTITY_KEYS) {
      while (key !== own && ` ${key} `.includes(` ${own} `)) {
        key = ` ${key} `.replace(` ${own} `, " ").trim().replace(/\s+/g, " ")
      }
    }
    key = ` ${key} `.replace(" via mercury com send money transaction initiated on mercury ", " ").trim().replace(/\s+/g, " ")
    key = key.replace(/\bfrom$/, "").replace(/^from\b/, "").trim()
    // Stripped to nothing = the string was ONLY own-name + wiring: a self-transfer.
    if (!key) key = OWN_ENTITY_KEYS[0]
  }
  return key
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
    // Rules match against the vendor IDENTITY (merchant marker wins, own-entity sender
    // noise stripped) — a "tony durante" rule must never chip every outgoing payment.
    const identity = vendorIdentity(tx.counterparty, tx.description)
    const matched = ordered.find(rule => {
      const pattern = rule.counterparty_pattern.toLowerCase()
      if (rule.match_type === 'exact') return counterparty === pattern
      // Normalized whole-token match on BOTH sides: a saved "stripe transfer" rule must
      // match the semicolon-worded Mercury variant too — but a "chase" rule must NOT
      // match "POS PURCHASE" wording (token boundaries, not raw substring). An empty
      // normalized pattern would match everything — treat it as matching nothing.
      if (rule.match_type === 'contains') {
        const np = normalizeVendorKey(pattern)
        return np !== '' && containsAsTokens(identity, np)
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
