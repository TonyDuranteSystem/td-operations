/**
 * Bank Feed Cascade — given an account + its contacts + its invoices, find
 * unmatched bank feeds that likely belong to this account, with tier and
 * confidence.
 *
 * Per ops-2026-05-02-billing-bank-audit-plan v2.2, Track B.
 *
 *   Tier 1 — email match              (HIGH)   contact email appears in feed text or stripe metadata
 *   Tier 2 — invoice reference        (HIGH)   account's invoice_number appears in feed text
 *   Tier 3 — company name fuzzy       (MEDIUM) account.company_name token appears in feed sender/memo
 *   Tier 4 — contact name fuzzy       (MEDIUM) contact full_name token appears in feed sender/memo
 *
 * NOT in scope: PL-NNNNN reference attribution. PL is an external Stripe payment link ID
 * with no DB mapping verified (sandbox 2026-05-02). Stripe charges with PL- always carry
 * the client email in metadata, so Tier 1 catches them.
 *
 * Pure function — no DB calls, no side effects. Tested in tests/unit/bank-feed-cascade.test.ts.
 */

import { evaluateNameEvidence } from "@/lib/finance/feed-signals"

export type CascadeTier = 1 | 2 | 3 | 4
export type CascadeConfidence = 'high' | 'medium'
export type CascadeRuleKey =
  | 'email_match'
  | 'reference_match'
  | 'company_name_match'
  | 'contact_name_match'

export interface CascadeAccount {
  id: string
  company_name: string | null
}

export interface CascadeContact {
  id: string
  full_name: string | null
  email: string | null
}

export interface CascadeFeed {
  id: string
  source: string
  transaction_date: string
  amount: number
  currency: string
  sender_name: string | null
  sender_reference: string | null
  memo: string | null
  status: string
  matched_payment_id: string | null
  matched_account_id: string | null
  raw_data: unknown
}

export interface CascadeInvoice {
  invoice_number: string | null
}

export interface OrphanFeedMatch {
  feed: CascadeFeed
  tier: CascadeTier
  confidence: CascadeConfidence
  rule: CascadeRuleKey
  rule_label: string
  match_evidence: string
}

/*
 * ⛔ THE PRIVATE STOP-WORD LIST AND THE ANY-ONE-TOKEN NAME TEST ARE GONE (2026-07-29).
 *
 * This module had its OWN copy of the list — and, like the matcher's, it was missing
 * "marketing". That mattered far more here than it looks: this file powers the "unmatched bank
 * deposits that look like they belong to this client" suggestions on the account audit panel,
 * and one click there CREATES A PAID INVOICE from the suggested transaction. So the exact
 * incident of 2026-07-22 was reachable through this screen even after the matcher was fixed —
 * and the resulting invoice is WORSE than the original, because it is created already Paid with
 * no money record behind it, which means the un-match path finds nothing to reverse.
 *
 * Name evidence now comes from the one shared implementation in `lib/finance/feed-signals.ts`,
 * which requires the matched words to COVER a minimum share of the name.
 */

const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi

function feedText(feed: CascadeFeed): string {
  const parts: string[] = [
    feed.sender_name ?? '',
    feed.memo ?? '',
    feed.sender_reference ?? '',
  ]
  // Stripe charges store the actual TD client name in metadata.Name (sender_name
  // is the cardholder, who can be a different person paying for the client).
  const meta = readMetadata(feed.raw_data)
  if (meta) {
    if (typeof meta.Name === 'string') parts.push(meta.Name)
    if (typeof meta.name === 'string') parts.push(meta.name)
  }
  return parts.join(' ').toLowerCase()
}

function readMetadata(rawData: unknown): Record<string, unknown> | null {
  if (!rawData || typeof rawData !== 'object') return null
  const md = (rawData as { metadata?: unknown }).metadata
  if (!md || typeof md !== 'object') return null
  return md as Record<string, unknown>
}

function extractFeedEmails(feed: CascadeFeed): string[] {
  const out = new Set<string>()
  const text = `${feed.sender_name ?? ''} ${feed.memo ?? ''} ${feed.sender_reference ?? ''}`
  const matches = text.match(EMAIL_RE) ?? []
  for (const m of matches) out.add(m.toLowerCase())

  if (feed.raw_data && typeof feed.raw_data === 'object') {
    const rd = feed.raw_data as {
      metadata?: { email?: unknown }
      billing_details?: { email?: unknown }
      receipt_email?: unknown
    }
    const candidates = [rd.metadata?.email, rd.billing_details?.email, rd.receipt_email]
    for (const c of candidates) {
      if (typeof c === 'string' && c.trim()) out.add(c.trim().toLowerCase())
    }
  }
  return Array.from(out)
}

function invoiceRefHit(feedTxt: string, invoiceNumbers: string[]): string | null {
  for (const inv of invoiceNumbers) {
    if (!inv) continue
    const lower = inv.toLowerCase()
    if (feedTxt.includes(lower)) return inv
    if (feedTxt.includes(lower.replace('inv-', 'inv '))) return inv
    if (feedTxt.includes(lower.replace('inv-', 'inv'))) return inv

    const m = inv.match(/inv[- ]?0*(\d+)/i)
    if (!m) continue
    const bare = parseInt(m[1], 10)
    const padded = String(bare).padStart(6, '0')
    const bareRe = new RegExp(`inv[- ]?0*${bare}\\b`, 'i')
    if (bareRe.test(feedTxt)) return inv
    if (feedTxt.includes(padded)) return inv
  }
  return null
}

/**
 * Does this payment's text name this client — and HOW STRONGLY?
 *
 * Uses the one shared name rule (`lib/finance/feed-signals.ts`), but unlike the matcher this
 * screen is a SUGGESTION list, so a partial hit is still worth showing: a surname on its own
 * ("BIANCHI WIRE" for Maria Bianchi) is a perfectly good hint for a human scanning deposits,
 * even though it is NOT enough for a machine to move money on.
 *
 * So nothing is hidden — but a partial hit SAYS it is partial. The evidence string is what the
 * audit panel puts in front of staff, and "partial name" vs a covered name is exactly the
 * difference between "worth a look" and "this is them". That distinction is the point: one click
 * on this screen creates a PAID invoice, so the strength of the evidence must not be rounded up.
 */
function nameFuzzyHit(feedTxt: string, name: string | null): string | null {
  if (!name) return null
  const evidence = evaluateNameEvidence(name, [feedTxt])
  if (evidence.matchedWords.length === 0) return null
  const matched = evidence.matchedWords.join(' + ')
  return evidence.sufficient ? matched : `partial name: ${matched}`
}

function classifyFeed(
  feed: CascadeFeed,
  account: CascadeAccount,
  contacts: CascadeContact[],
  accountInvoiceNumbers: string[],
): OrphanFeedMatch | null {
  const txt = feedText(feed)
  const contactEmails = contacts
    .map(c => c.email?.trim().toLowerCase())
    .filter((e): e is string => !!e && e.length > 0)

  // Tier 1 — email
  for (const e of extractFeedEmails(feed)) {
    if (contactEmails.includes(e)) {
      return {
        feed, tier: 1, confidence: 'high',
        rule: 'email_match', rule_label: 'Email match',
        match_evidence: e,
      }
    }
  }

  // Tier 2 — invoice reference
  const invHit = invoiceRefHit(txt, accountInvoiceNumbers)
  if (invHit) {
    return {
      feed, tier: 2, confidence: 'high',
      rule: 'reference_match', rule_label: 'Invoice ref in memo',
      match_evidence: invHit,
    }
  }

  // Tier 3 — company name
  const compHit = nameFuzzyHit(txt, account.company_name)
  if (compHit) {
    return {
      feed, tier: 3, confidence: 'medium',
      rule: 'company_name_match', rule_label: 'Company name match',
      match_evidence: compHit,
    }
  }

  // Tier 4 — contact name
  for (const c of contacts) {
    const hit = nameFuzzyHit(txt, c.full_name)
    if (hit) {
      return {
        feed, tier: 4, confidence: 'medium',
        rule: 'contact_name_match', rule_label: 'Contact name match',
        match_evidence: hit,
      }
    }
  }

  return null
}

/**
 * Find unmatched bank feeds that likely belong to this account.
 *
 * Skips feeds with status in ('outgoing','duplicate','ignored','matched') —
 * the audit panel only surfaces UNATTRIBUTED feeds (orphans).
 */
export function findFeedsForAccount(
  account: CascadeAccount,
  contacts: CascadeContact[],
  accountInvoices: CascadeInvoice[],
  candidateFeeds: CascadeFeed[],
): OrphanFeedMatch[] {
  const invoiceNumbers = accountInvoices
    .map(i => i.invoice_number?.trim())
    .filter((n): n is string => !!n && n.length > 0)

  const results: OrphanFeedMatch[] = []
  for (const feed of candidateFeeds) {
    if (feed.status !== 'unmatched') continue
    const match = classifyFeed(feed, account, contacts, invoiceNumbers)
    if (match) results.push(match)
  }

  // Sort: HIGH-confidence tiers (1,2) first, then MEDIUM (3,4), then date desc
  results.sort((a, b) => {
    if (a.tier !== b.tier) return a.tier - b.tier
    return b.feed.transaction_date.localeCompare(a.feed.transaction_date)
  })
  return results
}

export interface MercuryDuplicate {
  plaid_feed: CascadeFeed
  twin_feed: CascadeFeed
  attribution: 'matched' | 'cascade'
}

/**
 * Find Plaid-Mercury duplicate pairs that belong to this account.
 *
 * A duplicate = source='mercury' (Plaid pull) feed with a same-day, same-amount,
 * same-currency mercury_api twin in the candidate pool.
 *
 * Attribution to THIS account is established via:
 *   - matched_account_id on either side, OR
 *   - cascade match on the Plaid row, OR
 *   - cascade match on the twin
 *
 * Returns the Plaid (source='mercury') row as the deletion target.
 */
export function findPlaidMercuryDuplicates(
  account: CascadeAccount,
  contacts: CascadeContact[],
  accountInvoices: CascadeInvoice[],
  allFeeds: CascadeFeed[],
): MercuryDuplicate[] {
  const invoiceNumbers = accountInvoices
    .map(i => i.invoice_number?.trim())
    .filter((n): n is string => !!n && n.length > 0)

  const apiByKey = new Map<string, CascadeFeed>()
  for (const f of allFeeds) {
    if (f.source !== 'mercury_api') continue
    const key = `${f.transaction_date}|${Number(f.amount).toFixed(2)}|${(f.currency ?? '').toUpperCase()}`
    apiByKey.set(key, f)
  }

  const out: MercuryDuplicate[] = []
  for (const f of allFeeds) {
    if (f.source !== 'mercury') continue
    const key = `${f.transaction_date}|${Number(f.amount).toFixed(2)}|${(f.currency ?? '').toUpperCase()}`
    const twin = apiByKey.get(key)
    if (!twin) continue

    let attribution: 'matched' | 'cascade' | null = null
    if (f.matched_account_id === account.id) attribution = 'matched'
    else if (twin.matched_account_id === account.id) attribution = 'matched'
    else if (classifyFeed(f, account, contacts, invoiceNumbers)) attribution = 'cascade'
    else if (classifyFeed(twin, account, contacts, invoiceNumbers)) attribution = 'cascade'

    if (!attribution) continue
    out.push({ plaid_feed: f, twin_feed: twin, attribution })
  }
  return out
}
