/**
 * Bank account IDENTITY — how one real account is recognized across uploads.
 *
 * The problem this solves: the same account was splitting into two because its
 * bank NAME was read inconsistently across ingest paths ("Chase" from one file,
 * "JPMorgan Chase Bank, N.A." from another; "Slash" vs "Slash Financial, Inc.";
 * "Kraken (Payward Interactive, Inc.)"; the heuristic literal "Bank"; the generic
 * "unknown"). The engine identifies an account as `${bank_name} ${currency}`, so a
 * split name splits the account — breaking per-bank balance tie-outs, duplicating
 * the balance panel, and mis-booking internal transfers.
 *
 * The fix (see sysdoc `pnl-bank-account-identity-plan`):
 *   1. Canonicalize the bank NAME once, from a CURATED, data-driven registry —
 *      exact/known aliases only. NEVER fuzzy-merge (a wrong merge would corrupt
 *      "money from your own bank is not income"). Unknown names are left as-is and
 *      flagged for human classification — flag, don't guess.
 *   2. Classify each institution by IDENTITY MODE:
 *        - account_number: US/traditional banks + US fintechs. A client can hold
 *          two accounts here, so the client-provided account number discriminates.
 *        - currency: multi-currency services (Wise/Airwallex/Revolut/Payoneer).
 *          One profile, many currency balances → the currency discriminates; no
 *          account number is asked.
 *        - crypto: exchanges (Kraken/Coinbase). No bank account number → the
 *          asset/currency discriminates.
 *   3. Build the account identity key (`account_ref`) the engine groups on:
 *        account_number mode → `${canonical}#${account}` (currency still sub-divides)
 *        currency / crypto   → `${canonical}` (currency sub-divides via account_type)
 *
 * This module is PURE and DB-free so it is unit testable. The registry is injected
 * (default = the curated SEED below); the DB-backed loader (catalog_entries
 * 'bank_export_guides') merges/overrides the seed at runtime — nothing is
 * hardcoded to a fixed bank list; staff can add institutions in the catalog.
 */

export type IdentityMode = "account_number" | "currency" | "crypto"

export interface InstitutionEntry {
  /** Canonical display name every alias collapses to (e.g. "Chase"). */
  canonical: string
  mode: IdentityMode
  /**
   * Terms that UNAMBIGUOUSLY denote this institution. Matched by normalized
   * substring, longest term wins. NEVER add a near-miss / partial term that
   * could also appear in a different institution's name.
   */
  matchTerms: string[]
}

/**
 * Curated seed — the reviewed baseline and the fallback when the catalog is
 * unavailable. Covers the institutions seen across MMLLC clients plus Antonio's
 * three-bucket rule.
 *
 * SAFETY: matching is EXACT on the normalized full name (matchNorm) — NOT
 * substring. So "My Mercury" or "Chase County Credit Union" do NOT collapse to
 * Mercury / Chase (a wrong merge would corrupt "own-bank money is not income").
 * Enumerate every legal-form variant we actually expect; anything not listed
 * stays as-is and is flagged for human classification (flag, don't guess). New
 * variants are added here or, at runtime, in the bank_export_guides catalog.
 */
export const INSTITUTION_SEED: InstitutionEntry[] = [
  // ── account_number: US/traditional banks + US fintechs (have an account number)
  { canonical: "Chase", mode: "account_number", matchTerms: [
    "chase", "chase bank", "chase bank na", "chase bank n a",
    "jpmorgan", "jp morgan", "jpmorgan chase", "jp morgan chase",
    "jpmorgan chase bank", "jpmorgan chase bank na", "jpmorgan chase bank n a"] },
  { canonical: "Bank of America", mode: "account_number", matchTerms: [
    "bank of america", "bank of america na", "bank of america n a", "bofa"] },
  { canonical: "Wells Fargo", mode: "account_number", matchTerms: [
    "wells fargo", "wells fargo bank", "wells fargo bank na", "wells fargo bank n a"] },
  { canonical: "Mercury", mode: "account_number", matchTerms: ["mercury", "mercury bank"] },
  { canonical: "Relay", mode: "account_number", matchTerms: ["relay", "relay financial"] },
  { canonical: "Brex", mode: "account_number", matchTerms: ["brex"] },
  { canonical: "Slash", mode: "account_number", matchTerms: ["slash", "slash financial", "slash financial inc"] },
  // ── currency: multi-currency services (currency discriminates; no account number)
  { canonical: "Wise", mode: "currency", matchTerms: ["wise", "transferwise", "wise us inc"] },
  { canonical: "Airwallex", mode: "currency", matchTerms: ["airwallex"] },
  { canonical: "Revolut", mode: "currency", matchTerms: ["revolut", "revolut business"] },
  { canonical: "Payoneer", mode: "currency", matchTerms: ["payoneer"] },
  // ── crypto: exchanges (asset/currency discriminates; no bank account number)
  { canonical: "Kraken", mode: "crypto", matchTerms: [
    "kraken", "payward", "payward interactive", "payward interactive inc",
    "kraken payward interactive inc"] },
  { canonical: "Coinbase", mode: "crypto", matchTerms: ["coinbase"] },
]

/** Match-normalize: lowercase, ALL non-alphanumerics → single space, collapse.
 *  "JPMorgan Chase Bank, N.A." and "JPMORGAN CHASE BANK NA" both differ only by
 *  punctuation/case, which this folds away for EXACT comparison. */
function matchNorm(raw: string): string {
  return String(raw ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim()
}

export interface ResolvedInstitution {
  /** Canonical name if matched; the cleaned raw name if not. */
  canonical: string
  mode: IdentityMode
  /** false = not in the registry → treat as a bank (ask account #), offer the
   *  "multi-currency / crypto" escape, and flag for human classification. */
  matched: boolean
}

/**
 * Resolve a raw/AI-read bank name to a canonical institution + identity mode.
 * EXACT normalized match against the curated alias list — never substring, never
 * fuzzy. A name we don't recognize is returned as-is (cleaned) with matched=false
 * so the UI asks for classification rather than guessing a wrong merge.
 */
export function resolveInstitution(
  rawName: string,
  registry: InstitutionEntry[] = INSTITUTION_SEED,
): ResolvedInstitution {
  const q = matchNorm(rawName)
  if (q.length < 1) {
    return { canonical: cleanRawName(rawName), mode: "account_number", matched: false }
  }
  for (const e of registry) {
    for (const term of e.matchTerms) {
      if (matchNorm(term) === q) {
        return { canonical: e.canonical, mode: e.mode, matched: true }
      }
    }
  }
  return { canonical: cleanRawName(rawName), mode: "account_number", matched: false }
}

/** Canonical bank name for display / for currency+crypto identity. Unknown → cleaned raw. */
export function canonicalBankName(rawName: string, registry: InstitutionEntry[] = INSTITUTION_SEED): string {
  return resolveInstitution(rawName, registry).canonical
}

/**
 * Normalize a client-typed account number/label into a stable discriminator.
 * Trims, collapses whitespace, upper-cases, and drops separators so "  1234-5678 "
 * and "12345678" resolve equal. Keeps a non-numeric nickname as typed (upper). We
 * do NOT force digits — Antonio's rule allows "last 4" or a short label for banks
 * that have no clean number.
 */
export function normalizeAccountNumber(raw?: string | null): string {
  const s = String(raw ?? "").trim()
  if (!s) return ""
  return s.replace(/[\s\-_.]+/g, "").toUpperCase()
}

/** Last 4 alphanumerics of an account number (safe short discriminator, PII-min). */
export function accountLast4(raw?: string | null): string {
  const n = normalizeAccountNumber(raw)
  return n.length <= 4 ? n : n.slice(-4)
}

export interface AccountRefInput {
  rawBankName: string
  /** Client-provided account number/label. Ignored for currency/crypto modes. */
  accountNumber?: string | null
  registry?: InstitutionEntry[]
}

export interface AccountRefResult {
  /** The identity key the engine groups on (currency is appended separately). */
  account_ref: string
  canonical: string
  mode: IdentityMode
  /** true when this institution requires a client-provided account number. */
  needsAccountNumber: boolean
  /** true when the institution was not found in the registry (needs classification). */
  unknownInstitution: boolean
}

/**
 * Build the account identity key. For account_number-mode institutions the key is
 * `${canonical}#${account}` (currency still sub-divides via account_type); when no
 * account number is available yet (history / unlabeled), it falls back to the
 * canonical name alone so at least the name-drift split is healed. For
 * currency/crypto institutions the key is the canonical name — the currency does
 * the discriminating, so no account number is needed.
 */
export function buildAccountRef(input: AccountRefInput): AccountRefResult {
  const r = resolveInstitution(input.rawBankName, input.registry)
  if (r.mode === "account_number") {
    const acct = accountLast4(input.accountNumber)
    return {
      account_ref: acct ? `${r.canonical}#${acct}` : r.canonical,
      canonical: r.canonical,
      mode: r.mode,
      needsAccountNumber: true,
      unknownInstitution: !r.matched,
    }
  }
  return {
    account_ref: r.canonical,
    canonical: r.canonical,
    mode: r.mode,
    needsAccountNumber: false,
    unknownInstitution: !r.matched,
  }
}

/** Trim + collapse whitespace on a raw name we could not canonicalize (keep as the
 *  client/statement wrote it, just tidied — never invent or merge). */
export function cleanRawName(raw?: string | null): string {
  return String(raw ?? "").replace(/\s+/g, " ").trim()
}

/**
 * The engine's per-account grouping key: `${base} ${currency}`.
 * `base` is the stored `account_ref` when present (written at ingest / backfill);
 * otherwise the CANONICAL bank name (so the name-drift split is healed even for
 * rows not yet backfilled). `account_type` holds the currency ("USD"/"EUR"); the
 * `?? "Checking"` fallback preserves the pre-existing key format byte-for-byte for
 * rows with a null currency, so nothing regresses.
 *
 * This is the single source of the key — used by the engine (BankCashPosition),
 * coverage questions, and transfer-pair "same account" detection, so they can
 * never disagree.
 */
export function accountKeyOf(
  row: { account_ref?: string | null; bank_name?: string | null; account_type?: string | null },
  registry: InstitutionEntry[] = INSTITUTION_SEED,
): string {
  const ref = row.account_ref?.trim()
  const base = ref && ref.length > 0 ? ref : canonicalBankName(row.bank_name ?? "", registry)
  return `${base} ${row.account_type ?? "Checking"}`
}

/** Human-friendly label for an account_ref-based key: "Chase#5678 USD" → "Chase ••5678 · USD". */
export function formatAccountKey(key: string): string {
  const m = key.match(/^(.*?)#([^\s]+)\s+(.+)$/)
  if (m) return `${m[1]} ••${m[2]} · ${m[3]}`
  const sp = key.lastIndexOf(" ")
  return sp > 0 ? `${key.slice(0, sp)} · ${key.slice(sp + 1)}` : key
}
