/**
 * Stripe payouts — the source-of-truth list of TD's real Stripe payouts, so a bank
 * deposit that LOOKS like a Stripe transfer can be CONFIRMED against an actual payout
 * (by amount + arrival date) instead of trusting the bank's wording (Antonio, 2026-07-26).
 *
 * A "STRIPE - TRANSFER" deposit carries no Stripe payout id and Plaid's category is
 * unreliable — but Stripe itself knows every payout's exact amount and arrival date.
 * Matching a signature deposit to one of these rows upgrades a name guess to a certainty,
 * and it works on ANY bank (if payouts move from Relay to another account tomorrow, the
 * match still holds). Verified against live Stripe 2026-07-26: 22/22 stuck Relay payouts
 * matched a real payout exactly.
 */
import StripeConstructor from "stripe"
import { supabaseAdmin } from "@/lib/supabase-admin"

type StripeClient = ReturnType<typeof StripeConstructor>

let _stripe: StripeClient | null = null
function getStripe(): StripeClient | null {
  if (!_stripe) {
    const key = process.env.STRIPE_SECRET_KEY
    if (!key) return null
    try {
      _stripe = StripeConstructor(key)
    } catch {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      _stripe = new (StripeConstructor as any)(key)
    }
  }
  return _stripe
}

/** A stored payout row (mirrors the stripe_payouts table). */
export interface StripePayoutRow {
  id: string
  amount: number // SIGNED dollars, exactly as Stripe reports (a rare negative payout = money pulled back)
  currency: string
  arrival_date: string // YYYY-MM-DD (bank landing date)
  status: string
  livemode: boolean
}

/** The minimal Stripe payout shape we read (avoids depending on the SDK's evolving types). */
interface RawStripePayout {
  id: string
  amount: number // cents, signed
  currency: string
  arrival_date: number // unix seconds
  status: string
  livemode: boolean
}

/** Pure: Stripe payout object → a stored row. Cents→dollars (sign preserved), unix→date. */
export function mapPayoutToRow(p: RawStripePayout): StripePayoutRow {
  return {
    id: p.id,
    amount: Math.round(p.amount) / 100,
    currency: p.currency,
    arrival_date: new Date(p.arrival_date * 1000).toISOString().slice(0, 10),
    status: p.status,
    livemode: p.livemode,
  }
}

/** The minimal deposit shape `looksLikeStripePayoutDeposit` needs. */
export interface PayoutSignatureSource {
  sender_name?: string | null
  memo?: string | null
  sender_reference?: string | null
}

/**
 * Does this deposit already carry Stripe's OWN wording — the precondition
 * `matchPayoutForDeposit` was always meant to require (see the module header: "a client
 * wire of a coincidental amount does not carry the signature and is not tested here"), but
 * which no caller actually enforced until now.
 *
 * WHY THIS EXISTS (bug-hunter finding, 2026-08-22): without it, `matchPayoutForDeposit`
 * confirms a deposit purely by amount + date + currency — and a genuine client wire that
 * happens to land on the same amount, within a few days of a real TD payout, in the same
 * currency, would pass with ZERO other evidence. That is a coincidence a real client invoice
 * could actually produce (round amounts, weekly payout cycles). Requiring Stripe's own
 * wording closes that gap: verified against all 4 real production rows this exists for
 * (2026-08-22) — every one reads "STRIPE - TRANSFER" — and matches Antonio's own words:
 * "Stripe Payouts are Stripe Payouts. There is no way to guess anything."
 */
export function looksLikeStripePayoutDeposit(feed: PayoutSignatureSource): boolean {
  const text = `${feed.sender_name ?? ""} ${feed.memo ?? ""} ${feed.sender_reference ?? ""}`
  return /stripe/i.test(text)
}

/**
 * Pure: does a bank deposit match a real Stripe payout? Given the deposit's ABSOLUTE
 * amount + its date + its currency, find a payout of the same amount AND currency whose
 * arrival date is within `windowDays` (bank post-date can lag Stripe's arrival_date by a day
 * or two). Returns the closest-dated match, or null. Amounts compared to the cent to avoid
 * float drift; currency compared case-insensitively (Stripe returns lowercase codes, e.g.
 * "usd" — this file's callers elsewhere in the codebase compare uppercase).
 *
 * Currency is filtered INSIDE the loop, before the amount/date comparison decides the
 * closest match — not as a post-filter on the winner. A post-filter would let a wrong-currency
 * payout with a closer date shadow the correct same-currency one (e.g. a EUR payout dated
 * closer than the real USD payout for the same numeric amount) — found in review, 2026-08-22.
 *
 * This is intentionally amount+date+currency over a SIGNATURE-flagged deposit: the deposit
 * already says "Stripe transfer", and requiring a real payout to exist is what makes it
 * certain — a client wire of a coincidental amount does not carry the signature and is not
 * tested here.
 */
export function matchPayoutForDeposit(
  depositAmountAbs: number,
  depositDate: string,
  depositCurrency: string,
  payouts: StripePayoutRow[],
  windowDays = 3,
): StripePayoutRow | null {
  const cents = Math.round(depositAmountAbs * 100)
  const depDay = Date.parse(depositDate)
  if (Number.isNaN(depDay)) return null
  const wantCurrency = (depositCurrency || "usd").trim().toLowerCase()

  let best: StripePayoutRow | null = null
  let bestGap = Infinity
  for (const p of payouts) {
    if ((p.currency || "usd").trim().toLowerCase() !== wantCurrency) continue
    if (Math.round(Math.abs(p.amount) * 100) !== cents) continue
    const gap = Math.abs(Date.parse(p.arrival_date) - depDay) / 86_400_000
    if (gap <= windowDays && gap < bestGap) {
      best = p
      bestGap = gap
    }
  }
  return best
}

/** Fetch every payout from Stripe (paginated). */
async function fetchAllStripePayouts(stripe: StripeClient): Promise<RawStripePayout[]> {
  const out: RawStripePayout[] = []
  let startingAfter: string | undefined
  for (;;) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const page: any = await (stripe as any).payouts.list({ limit: 100, starting_after: startingAfter })
    for (const p of page.data as RawStripePayout[]) out.push(p)
    if (!page.has_more || page.data.length === 0) break
    startingAfter = page.data[page.data.length - 1].id
  }
  return out
}

export interface PayoutSyncResult {
  ok: boolean
  synced: number
  total: number
  error?: string
}

/**
 * Pull payouts from Stripe and upsert them into stripe_payouts (LIVE mode only — a
 * test-mode payout must never be able to confirm a real deposit). Idempotent: the table's
 * primary key is the payout id, so a re-run refreshes in place. Sign is preserved.
 */
export async function syncStripePayouts(): Promise<PayoutSyncResult> {
  const stripe = getStripe()
  if (!stripe) return { ok: false, synced: 0, total: 0, error: "STRIPE_SECRET_KEY not set" }

  let raw: RawStripePayout[]
  try {
    raw = await fetchAllStripePayouts(stripe)
  } catch (e) {
    return { ok: false, synced: 0, total: 0, error: e instanceof Error ? e.message : "stripe payouts fetch failed" }
  }

  const rows = raw.filter((p) => p.livemode).map(mapPayoutToRow)
  if (rows.length === 0) return { ok: true, synced: 0, total: raw.length }

  const { error } = await supabaseAdmin.from("stripe_payouts").upsert(rows, { onConflict: "id" })
  if (error) return { ok: false, synced: 0, total: raw.length, error: error.message }
  return { ok: true, synced: rows.length, total: raw.length }
}

/**
 * DB lookup: is there a real stored payout matching this deposit (absolute amount +
 * currency + date within a few days)? Returns the payout id, or null. Reads only LIVE payouts.
 */
export async function findPayoutIdForDeposit(
  depositAmountAbs: number,
  depositDate: string,
  depositCurrency: string,
  windowDays = 3,
): Promise<string | null> {
  const from = new Date(Date.parse(depositDate) - windowDays * 86_400_000).toISOString().slice(0, 10)
  const to = new Date(Date.parse(depositDate) + windowDays * 86_400_000).toISOString().slice(0, 10)
  const { data, error } = await supabaseAdmin
    .from("stripe_payouts")
    .select("id, amount, currency, arrival_date, status, livemode")
    .eq("livemode", true)
    .gte("arrival_date", from)
    .lte("arrival_date", to)
  if (error || !data) return null
  const match = matchPayoutForDeposit(depositAmountAbs, depositDate, depositCurrency, data as StripePayoutRow[], windowDays)
  return match ? match.id : null
}
