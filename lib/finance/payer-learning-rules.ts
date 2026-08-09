/**
 * Payer learning — the rules that decide WHAT may be taught, and how a payer is keyed.
 *
 * Pure. Dev jobs `ae8b8bb1` / `c0a61e44`. Design approved by Antonio 2026-08-09.
 *
 * A mapping is only ever created by a deliberate human click. These rules do not decide
 * anything about money; they decide whether a given transaction carries a payer identity
 * that is SAFE TO REMEMBER, and what that identity is.
 *
 * ── THE ONE AUTOMATIC PROTECTION LEFT ────────────────────────────────────────────────────
 * The original design blocked a payer once two different clients appeared behind it. Antonio
 * replaced that with per-client confirmation, because the real book proved multi-client payers
 * are NORMAL: William's descriptor legitimately pays his own company AND InkMedia (different
 * owner), and five more third-party payers behave the same way. Blocking them would have
 * fought the business.
 *
 * That makes the PROCESSOR LIST the only guard that still fires by itself, so it is
 * load-bearing and it is checked in two places: when a mapping is taught, and again when one
 * is used, so that adding a processor later also disarms mappings taught before.
 *
 * The list is finite and measured, not a wording heuristic — on confirmed client money the
 * word "Mercury" sits behind 49 different clients and "Wise" behind 33. Teaching a bare
 * "WISE US INC" to one client would hand it every future Wise-routed payment.
 */

/**
 * Payment processors, banks and money-transmitters whose name identifies the RAIL, never the
 * payer. Finite by design — Antonio's explicit condition for allowing a list at all.
 */
export const PAYMENT_PROCESSOR_TOKENS: ReadonlySet<string> = new Set([
  "stripe",
  "wise",
  "transferwise",
  "revolut",
  "mercury",
  "airwallex",
  "nium",
  "payoneer",
  "paypal",
  "remitly",
  "worldremit",
  "currencycloud",
  "currency",
  "cloud",
  "relay",
  "plaid",
  "banking",
  "circle",
  "intuit",
  "visa",
  "mastercard",
])

/**
 * Filler that carries no payer identity: legal suffixes, connectives and the vocabulary banks
 * wrap around a transfer.
 *
 * ⛔ THIS IS DELIBERATELY *NOT* THE NAME RULE'S STOP-WORD LIST, and the reason is the whole
 * point. That list exists to stop generic words identifying a client, so it drops words like
 * "international" and "consulting". Reusing it here inverts the test: "WM International — From
 * WM International LLC via mercury.com" would reduce to nothing and be refused as
 * processor-only — blocking exactly the payer the name rule already cannot see, which is the
 * case payer learning exists to solve. For THIS test a generic-sounding company word is
 * content, because a human is the one deciding.
 */
export const PAYER_FILLER_TOKENS: ReadonlySet<string> = new Set([
  // Legal suffixes
  "llc", "inc", "ltd", "limited", "corp", "corporation", "plc", "gmbh", "srl", "sa", "sarl", "bv", "ag", "lp", "llp",
  // Connectives / articles
  "the", "and", "for", "via", "from", "to", "of", "by", "with", "your",
  // Bank/transfer vocabulary
  "transfer", "transfers", "payment", "payments", "pmt", "ach", "wire", "deposit", "credit",
  "merchant", "name", "ref", "reference", "com", "www", "http", "https",
  // Country/geo shorthands that appear on rails
  "us", "usa", "uk", "eu",
])

/** Lower-case, strip punctuation to spaces, collapse whitespace. */
export function normalisePayerText(text: string | null | undefined): string {
  return (text ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ")
}

/** The tokens of a payer descriptor, with pure numbers dropped (dates, references, amounts). */
export function payerTokens(text: string | null | undefined): string[] {
  return normalisePayerText(text)
    .split(" ")
    .filter((t) => t.length > 0 && !/^\d+$/.test(t))
}

/**
 * Is this descriptor NOTHING BUT a payment rail?
 *
 * True when every token that survives filler-stripping is a processor name. Such a descriptor
 * is shared by every client who ever pays through that rail, so it can never be taught.
 */
export function isProcessorOnlyDescriptor(descriptor: string | null | undefined): boolean {
  const tokens = payerTokens(descriptor).filter((t) => !PAYER_FILLER_TOKENS.has(t))
  if (tokens.length === 0) return true // nothing but filler — identifies nobody either
  return tokens.every((t) => PAYMENT_PROCESSOR_TOKENS.has(t))
}

/** Which processor names a descriptor mentions — for explaining a refusal to a human. */
export function processorsNamed(descriptor: string | null | undefined): string[] {
  return Array.from(new Set(payerTokens(descriptor).filter((t) => PAYMENT_PROCESSOR_TOKENS.has(t))))
}

/** The identity a taught mapping is keyed on. */
export interface PayerKey {
  key_type: "descriptor" | "counterparty_id"
  key_value: string
  /** The payer exactly as the bank wrote it — display only, never matched on. */
  display_payer: string | null
}

export interface KeyableFeed {
  source?: string | null
  sender_name?: string | null
  raw_data?: unknown
}

/**
 * Resolve the strongest available payer identity.
 *
 * Prefers a structured id the source supplied, because a descriptor is only as stable as the
 * bank's formatting. Measured reality: only Mercury's own API provides one (on 136 of 136
 * rows); Airwallex, the Plaid-backed feeds and Stripe provide none, so almost every mapping
 * will be a descriptor. That is not a shortcut — it is the best identity that exists.
 *
 * ⛔ Reads `sender_name` ONLY, never the memo or the reference. Both of those carry
 * descriptions naming third parties: Mercury's referral bonuses say "Cash bonus for referring
 * <CLIENT> LLC" in both fields, and learning from them would remember TD's own bonus as that
 * client's payer.
 */
export function resolvePayerKey(feed: KeyableFeed): PayerKey | null {
  const raw = (feed.raw_data && typeof feed.raw_data === "object" ? feed.raw_data : {}) as Record<string, unknown>

  const counterpartyId = typeof raw.counterpartyId === "string" ? raw.counterpartyId.trim() : ""
  if (counterpartyId) {
    return {
      key_type: "counterparty_id",
      key_value: counterpartyId,
      display_payer: feed.sender_name?.trim() || null,
    }
  }

  const normalised = normalisePayerText(feed.sender_name)
  if (!normalised) return null

  return {
    key_type: "descriptor",
    key_value: normalised,
    display_payer: feed.sender_name?.trim() || null,
  }
}

// ────────────────────────────────────────────────────────────────────────────────────────
// LOOKUP — pure, so the router stays synchronous and testable.
//
// The caller loads every live mapping ONCE per pass and builds this index; the router then
// answers from memory. Deliberately not a per-transaction query: the sweep walks up to 2,000
// rows, and a lookup per row would make an advisory hint cost more than the reconciliation it
// is helping.
// ────────────────────────────────────────────────────────────────────────────────────────

/** The shape the index needs. The data layer's richer row satisfies this structurally. */
export interface TaughtMapping {
  id: string
  source: string
  key_type: PayerKey["key_type"]
  key_value: string
  account_id: string | null
  contact_id: string | null
  display_payer?: string | null
  taught_by?: string
  taught_at?: string
}

export type TaughtPayerIndex = Map<string, TaughtMapping[]>

const indexKey = (source: string, keyType: string, keyValue: string) => `${source}|${keyType}|${keyValue}`

export function buildTaughtPayerIndex(mappings: TaughtMapping[]): TaughtPayerIndex {
  const index: TaughtPayerIndex = new Map()
  for (const m of mappings) {
    const k = indexKey(m.source, m.key_type, m.key_value)
    const list = index.get(k)
    if (list) list.push(m)
    else index.set(k, [m])
  }
  return index
}

export interface TaughtLookupResult {
  mappings: TaughtMapping[]
  /** Live mappings existed but were ignored because the payer is now a known rail. */
  suppressedAsProcessor: boolean
}

/**
 * Which clients has a human taught this payer to pay for?
 *
 * ⛔ THE RAIL GUARD RUNS AGAIN HERE. Once per-client confirmation replaced the multi-client
 * block, the processor list became the only protection that fires by itself — so adding a rail
 * to the list must also disarm mappings taught before that addition. Checking only at teach time
 * would leave those mappings live for ever.
 */
export function taughtClientsFor(
  feed: KeyableFeed & { status?: string | null },
  index: TaughtPayerIndex,
): TaughtLookupResult {
  if (feed.status === "outgoing") return { mappings: [], suppressedAsProcessor: false }

  const key = resolvePayerKey(feed)
  if (!key) return { mappings: [], suppressedAsProcessor: false }

  const found = index.get(indexKey(feed.source ?? "manual", key.key_type, key.key_value)) ?? []
  if (found.length === 0) return { mappings: [], suppressedAsProcessor: false }

  if (key.key_type === "descriptor" && isProcessorOnlyDescriptor(feed.sender_name)) {
    return { mappings: [], suppressedAsProcessor: true }
  }

  return { mappings: found, suppressedAsProcessor: false }
}

export type TeachRefusal =
  | "money_leaving"
  | "processor_only"
  | "no_payer_identity"

export interface TeachEligibility {
  ok: boolean
  refusal?: TeachRefusal
  /** Plain-English reason, shown to the person who clicked. */
  detail?: string
  key?: PayerKey
}

export interface TeachableFeed extends KeyableFeed {
  status?: string | null
}

/**
 * May this transaction's payer be remembered at all?
 *
 * Refusals are explained rather than silent: a person who clicked deserves to know why nothing
 * was learned, otherwise they will click again.
 */
export function evaluateTeachEligibility(feed: TeachableFeed): TeachEligibility {
  if (feed.status === "outgoing") {
    return {
      ok: false,
      refusal: "money_leaving",
      detail: "This is money leaving the account, so there is no client payer to remember.",
    }
  }

  const key = resolvePayerKey(feed)
  if (!key) {
    return {
      ok: false,
      refusal: "no_payer_identity",
      detail: "The bank gave no payer name on this transaction, so there is nothing to remember it by.",
    }
  }

  // A structured id from the source identifies one counterparty, so the processor test does not
  // apply to it — "Mercury" as a counterparty NAME is a rail, but a Mercury counterparty ID is
  // a specific sender.
  if (key.key_type === "descriptor" && isProcessorOnlyDescriptor(feed.sender_name)) {
    const named = processorsNamed(feed.sender_name)
    return {
      ok: false,
      refusal: "processor_only",
      detail:
        `"${feed.sender_name?.trim() || "this payer"}" names only a payment service` +
        `${named.length ? ` (${named.join(", ")})` : ""}, not a client. Many different clients pay through it, ` +
        `so remembering it for one of them would misattribute everyone else's money. Match this one by hand.`,
      key,
    }
  }

  return { ok: true, key }
}
