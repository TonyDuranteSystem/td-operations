/**
 * Resolving a Plaid-synced transaction to the SAME account identity the hand-entered books
 * already use — by NUMBER, never by name.
 *
 * Antonio, 2026-09-10/11, after the first version of this asked him to type a bank name and
 * remember a cutover date: "the system must be flexible and not expect the perfect same name
 * or sequence words in the file name. it's important the account number." He is right, and it
 * is provably right against this system's own data: the account registry's own `institution`
 * field for First Citizens is "FirstCitizens", while the books' own `bank_name` for the same
 * account reads "Firstcitizenbank" — two different spellings inside ONE system, for one real
 * account. A name comparison would already disagree with itself. `account_number` (Chase
 * "3920", First Citizens "5820") is the one fact every source agrees on, because it comes from
 * the bank, not from anyone's typing.
 */
import type { OwnerAccountType } from "@/lib/owner-statement-filename"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { TD_ENTITY_ID } from "@/lib/owner-finance"

/**
 * Plaid's own account type/subtype -> the books' account-type vocabulary. Plaid's "transactions"
 * product describes depository and credit accounts well (checking/savings/credit card); it has
 * no clean equivalent for a LOAN in the same product (that is Plaid's separate "liabilities"
 * product, not wired up here) — returning null for anything unmapped is deliberate: a mapping
 * this function is not sure of must not silently mislabel a liability as cash.
 */
export function mapPlaidAccountType(plaidType: string, plaidSubtype: string | null): OwnerAccountType | null {
  const subtype = (plaidSubtype ?? "").toLowerCase()
  const type = plaidType.toLowerCase()
  if (type === "depository" && subtype === "checking") return "checking"
  if (type === "depository" && subtype === "savings") return "savings"
  if (type === "credit" && (subtype === "credit card" || subtype === "credit_card" || subtype === "")) return "credit_card"
  return null
}

/**
 * Do these two account numbers refer to the same real account? Plaid's `mask` is normally the
 * last 4 digits; a hand-typed filename might carry a longer run (the account-registry's own
 * `account_number` is whatever `parseStatementFilename` extracted, 3-6 digits). Compared as a
 * SUFFIX match rather than exact-equality so "3920" (Plaid) and a hypothetical longer "0003920"
 * (a filename) still agree — both empty/blank inputs never match, since an unresolved number
 * must never masquerade as a match.
 */
export function accountNumbersMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = (a ?? "").trim()
  const y = (b ?? "").trim()
  if (!x || !y) return false
  return x.endsWith(y) || y.endsWith(x)
}

export interface PlaidSubAccount {
  account_id: string
  mask: string | null
  type: string
  subtype: string | null
}

export interface ResolvedAccountIdentity {
  accountNumber: string
  accountType: OwnerAccountType
}

/**
 * Given a transaction's Plaid account_id and the connection's own stored sub-account list
 * (captured once at connect time via Plaid's accountsGet, in plaid_connections.accounts),
 * resolve which physical account it belongs to. Returns null when the sub-account can't be
 * found or its type doesn't map cleanly — the caller's fallback is today's coarse
 * institution-only label, never a guess.
 */
export function resolvePlaidTransactionAccount(
  plaidAccountId: string,
  connectionAccounts: PlaidSubAccount[],
): ResolvedAccountIdentity | null {
  const sub = connectionAccounts.find(a => a.account_id === plaidAccountId)
  if (!sub || !sub.mask) return null
  const accountType = mapPlaidAccountType(sub.type, sub.subtype)
  if (!accountType) return null
  return { accountNumber: sub.mask, accountType }
}

export interface OwnerAccountRegistryEntry {
  bank_name: string
  account_number: string
  account_type: OwnerAccountType
  sign_convention: "normal" | "inverted"
}

/**
 * Find the registry row for a resolved Plaid account, by NUMBER — never by any name. A
 * registry miss (a genuinely new account, not yet in td_books_accounts) returns null; the
 * caller falls back to the coarse institution label with the normal (unflipped) sign, exactly
 * today's behavior for an account nobody has described yet.
 */
/**
 * Fetch the account registry once per caller — a small, per-entity table, cheap to read
 * whole. Shared by lib/plaid-sync.ts (the duplicate check) and
 * lib/finance/owner-ledger-projection.ts (labeling the final books row) so both use the
 * exact same live data, never two independent reads that could disagree.
 */
export async function fetchOwnerAccountRegistry(): Promise<OwnerAccountRegistryEntry[]> {
  const { data, error } = await supabaseAdmin
    .from('td_books_accounts' as never)
    .select('bank_name, account_number, account_type, sign_convention')
    .eq('entity_id', TD_ENTITY_ID)
    .eq('is_active', true)
  if (error) throw new Error(`account registry read failed: ${error.message}`)
  return (data ?? []) as unknown as OwnerAccountRegistryEntry[]
}

export function findRegistryEntryForAccount(
  identity: ResolvedAccountIdentity,
  registry: OwnerAccountRegistryEntry[],
): OwnerAccountRegistryEntry | null {
  return registry.find(
    r => r.account_type === identity.accountType && accountNumbersMatch(r.account_number, identity.accountNumber)
  ) ?? null
}

export interface BookTransactionContent {
  transaction_date: string
  amount: number
  currency: string
  bank_name: string
}

/**
 * A hand-entered manual row, identified by its own id so a match against it can be recorded
 * and never repeated in a later, separate sync call (see partitionAgainstManualBooks below).
 */
export interface ExistingManualRow extends BookTransactionContent {
  id: string
}

function contentKey(t: BookTransactionContent): string {
  return `${t.transaction_date}|${Number(t.amount).toFixed(2)}|${(t.currency || "USD").toUpperCase()}|${t.bank_name}`
}

export interface DuplicateMatch<T> {
  candidate: T
  consumedManualRowId: string
}

/**
 * Which of these newly-synced candidates are already in the hand-entered books? Same
 * principle as `partitionAgainstExisting` in lib/owner-transactions-import.ts (multiset
 * counting, not a plain existence test — two genuinely separate same-day, same-amount
 * transactions on one account are real and must both survive), reimplemented here with its
 * own types because this call site's data (Plaid transactions, already resolved to a
 * registry-canonical bank_name) doesn't naturally fit that function's shape — the ALGORITHM
 * is deliberately identical, not a second, different rule.
 *
 * Unlike a single-batch check, this only decides WHICH manual row a candidate would consume —
 * it does not by itself guarantee that row hasn't already been consumed by an earlier, separate
 * sync call. The caller (lib/plaid-sync.ts) persists the consumption via plaid_match_consumption
 * and must exclude already-consumed rows from `existingManual` on every call, so the same
 * manual row can never absorb two different real transactions across the connection's lifetime.
 *
 * Callers must pass `existingManual` already filtered to hand-entered rows only
 * (transaction_ref not starting 'feed:') — comparing against the sweep's own prior output
 * would let a real transaction arriving in a later sync cycle be wrongly matched against
 * this cycle's own earlier insert.
 */
export function partitionAgainstManualBooks<T extends BookTransactionContent>(
  candidates: T[],
  existingManual: ExistingManualRow[],
): { toSync: T[]; skippedAsDuplicate: DuplicateMatch<T>[] } {
  const available = new Map<string, string[]>()
  for (const row of existingManual) {
    const key = contentKey(row)
    const ids = available.get(key) ?? []
    ids.push(row.id)
    available.set(key, ids)
  }

  const toSync: T[] = []
  const skippedAsDuplicate: DuplicateMatch<T>[] = []
  for (const candidate of candidates) {
    const key = contentKey(candidate)
    const ids = available.get(key)
    // Checked by presence in the list, never by truthiness of the id itself — an id is always
    // a real database uuid in production, but a check like `if (id)` would wrongly treat a
    // falsy-but-valid id as "no match" if that ever stopped being true.
    if (ids && ids.length > 0) {
      const consumedManualRowId = ids.shift() as string
      skippedAsDuplicate.push({ candidate, consumedManualRowId })
    } else {
      toSync.push(candidate)
    }
  }
  return { toSync, skippedAsDuplicate }
}
