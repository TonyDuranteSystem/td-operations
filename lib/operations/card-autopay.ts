/**
 * Card-autopay enrollment operations — the saved card itself, separate from
 * the charge-time race fix in lib/operations/autopay-claim.ts.
 *
 * Enrollment is on-session by design (Stripe's own recommended pattern): the
 * client is present, sees a real Stripe Checkout page in "setup" mode, and
 * enters their card there. We never see or touch raw card data.
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

interface AccountAutopayRow {
  autopay_stripe_customer_id: string | null
}

/**
 * Is this account enrolled in card autopay? The single check every invoice
 * creator uses to decide whether to waive the card fee on a NEW invoice —
 * see createTDInvoice's card_fee_rate default in lib/portal/td-invoice.ts.
 * Fails closed (false) on a lookup error or a missing account_id: a config
 * miss must never accidentally waive a fee that should have been charged.
 */
export async function isAccountAutopayEnabled(accountId: string | null | undefined): Promise<boolean> {
  if (!accountId) return false
  const { data, error } = await supabaseAdmin
    .from("accounts")
    .select("autopay_card_enabled" as never)
    .eq("id", accountId)
    .maybeSingle()
  if (error || !data) return false
  return (data as unknown as { autopay_card_enabled: boolean | null }).autopay_card_enabled === true
}

/**
 * Returns the account's existing Stripe Customer id, or creates one.
 * Reuses lib/portal/resolve-payment-recipient's account-level fallback
 * (owner-role contact → any contact → account.communication_email) so the
 * Customer carries the same email an invoice would go to.
 */
export async function getOrCreateStripeCustomerForAccount(accountId: string): Promise<
  { customerId: string } | { error: string }
> {
  const { data: account, error: accountErr } = await supabaseAdmin
    .from("accounts")
    .select("autopay_stripe_customer_id, company_name" as never)
    .eq("id", accountId)
    .single()

  if (accountErr || !account) return { error: "Account not found" }

  const existing = (account as unknown as AccountAutopayRow).autopay_stripe_customer_id
  if (existing) return { customerId: existing }

  // Only require a working Stripe key once we actually need to CREATE a
  // customer — an account with one already saved never needs it.
  const stripe = getStripe()
  if (!stripe) return { error: "STRIPE_SECRET_KEY not set" }

  const { resolvePaymentRecipient } = await import("@/lib/portal/resolve-payment-recipient")
  const recipient = await resolvePaymentRecipient({ contact_id: null, account_id: accountId }, supabaseAdmin)

  const customer = await stripe.customers.create({
    email: recipient?.email || undefined,
    name: recipient?.name || (account as unknown as { company_name?: string }).company_name || undefined,
    metadata: { account_id: accountId, source: "td-operations-card-autopay" },
  })

  const { error: saveErr } = await supabaseAdmin
    .from("accounts")
    .update({ autopay_stripe_customer_id: customer.id } as never)
    .eq("id", accountId)

  if (saveErr) {
    console.error(`[card-autopay] failed to save stripe customer id for account ${accountId}:`, saveErr.message)
  }

  return { customerId: customer.id }
}

export async function createAutopaySetupCheckoutSession(params: {
  accountId: string
  customerId: string
  returnUrl: string
}): Promise<{ url: string } | { error: string }> {
  const stripe = getStripe()
  if (!stripe) return { error: "STRIPE_SECRET_KEY not set" }

  // returnUrl may already carry a query string (e.g. ?tab=expenses) — join
  // with & in that case, never a second literal ?.
  const joiner = params.returnUrl.includes("?") ? "&" : "?"

  try {
    const session = await stripe.checkout.sessions.create({
      mode: "setup",
      customer: params.customerId,
      payment_method_types: ["card"],
      metadata: { account_id: params.accountId, source: "td-operations-card-autopay" },
      success_url: `${params.returnUrl}${joiner}autopay=success`,
      cancel_url: `${params.returnUrl}${joiner}autopay=cancelled`,
    })
    if (!session.url) return { error: "Stripe did not return a checkout URL" }
    return { url: session.url }
  } catch (err) {
    console.error("[card-autopay] setup checkout session creation failed:", err)
    return { error: err instanceof Error ? err.message : String(err) }
  }
}

/** Called from the Stripe webhook once the client finishes the on-session setup. */
export async function saveAutopayCard(params: {
  accountId: string
  stripeCustomerId: string
  paymentMethodId: string
  last4: string | null
}): Promise<void> {
  // Backstop against a session created while the global switch was off (e.g.
  // a staff enrollment link sent before the switch was flipped off) — the
  // webhook must not arm an account the moment it completes if the feature
  // is supposed to be dark system-wide (council review, 2026-08-30).
  const { isCardAutopayEnabled } = await import("@/lib/payments/card-autopay-config")
  if (!(await isCardAutopayEnabled())) {
    console.warn(`[card-autopay] saveAutopayCard refused for account ${params.accountId} — kill switch is off`)
    return
  }

  const { error } = await supabaseAdmin
    .from("accounts")
    .update({
      autopay_stripe_customer_id: params.stripeCustomerId,
      autopay_stripe_payment_method_id: params.paymentMethodId,
      autopay_card_last4: params.last4,
      autopay_card_enabled: true,
    } as never)
    .eq("id", params.accountId)

  if (error) {
    console.error(`[card-autopay] saveAutopayCard failed for account ${params.accountId}:`, error.message)
    return
  }

  try {
    await supabaseAdmin.from("action_log").insert({
      actor: "system",
      action_type: "card_autopay_enrolled",
      table_name: "accounts",
      record_id: params.accountId,
      account_id: params.accountId,
      summary: `Card autopay enrolled — card ending ${params.last4 || "????"}`,
      details: { payment_method_id: params.paymentMethodId, last4: params.last4 },
    })
  } catch { /* audit is best-effort */ }

  try {
    const { emitCardAutopayEnabledEvent } = await import("@/lib/portal/chat-events")
    await emitCardAutopayEnabledEvent({ accountId: params.accountId, last4: params.last4 })
  } catch (err) {
    // Best-effort — never blocks enrollment — but a swallowed exception here
    // means staff silently never learn a client enrolled, the headline thing
    // this feature exists for (QA-Tester finding, council review 2026-08-30).
    console.warn(`[card-autopay] emitCardAutopayEnabledEvent failed for account ${params.accountId}:`, err instanceof Error ? err.message : String(err))
  }
}

/**
 * Turn off autopay — detaches the saved card from Stripe too. Used by both
 * the client's own self-service toggle (actor defaults to "client") and the
 * new staff action on the account's Finance card (actor is "dashboard:<name>").
 */
export async function disableAutopayCard(accountId: string, actor: string = "client", deletedByUserId?: string): Promise<{ ok: boolean; error?: string }> {
  const stripe = getStripe()

  const { data: account, error: fetchErr } = await supabaseAdmin
    .from("accounts")
    .select("autopay_card_enabled, autopay_stripe_payment_method_id" as never)
    .eq("id", accountId)
    .single()

  if (fetchErr) return { ok: false, error: fetchErr.message }

  const accountRow = account as unknown as { autopay_card_enabled: boolean | null; autopay_stripe_payment_method_id: string | null } | null
  const paymentMethodId = accountRow?.autopay_stripe_payment_method_id

  // The DB write happens BEFORE the Stripe detach (2026-08-31 reorder,
  // ai-architect + senior-engineer finding). autopay_card_enabled is the
  // ONLY field any charging code trusts — committing it first means a
  // detach failure can never leave "enabled=true with a dead payment
  // method" (the old order could: detach, then a DB write failure left the
  // stale pm id enabled and chargeable-but-broken every cron run).
  //
  // Conditional on the payment-method id still matching what we just read —
  // an optimistic-concurrency guard so a disable racing a fresh re-enrollment
  // (a client's webhook completing at the same moment) can't silently wipe
  // the brand-new card, or silently report success while the account is
  // actually still enrolled (bug-hunter finding, council review 2026-08-30).
  const clearFields = {
    autopay_card_enabled: false,
    autopay_stripe_payment_method_id: null,
    autopay_card_last4: null,
  }
  // Type-erased to a minimal interface — chaining a second .eq()/.is() onto
  // the full generated `accounts` update builder hits TS's recursion limit
  // (TS2589) on this table's type surface; the runtime call is unaffected.
  interface MinimalUpdateChain {
    eq: (col: string, val: string) => MinimalUpdateChain
    is: (col: string, val: null) => MinimalUpdateChain
    select: (cols: string) => Promise<{ data: { id: string }[] | null; error: { message: string } | null }>
  }
  const updateChain = (supabaseAdmin.from("accounts").update(clearFields as never) as unknown as { eq: (col: string, val: string) => MinimalUpdateChain }).eq("id", accountId)
  const { data: updatedRows, error: updateErr } = paymentMethodId
    ? await updateChain.eq("autopay_stripe_payment_method_id", paymentMethodId).select("id")
    : await updateChain.is("autopay_stripe_payment_method_id", null).select("id")

  if (updateErr) return { ok: false, error: updateErr.message }
  if (!updatedRows || updatedRows.length === 0) {
    // 0 rows matched means the card on file changed since we read it — but
    // that includes the completely benign case of a genuine double-disable
    // (two clicks, or the account and contact page both open): the FIRST
    // call already cleared the row, so re-checking finds autopay already
    // off and reports success instead of a false "changed concurrently"
    // error (senior-engineer finding, council review 2026-08-31). Only a
    // row that's still enabled with a DIFFERENT payment method (a real
    // re-enrollment raced us) is the genuine conflict.
    const { data: current } = await supabaseAdmin
      .from("accounts")
      .select("autopay_card_enabled, autopay_stripe_payment_method_id" as never)
      .eq("id", accountId)
      .single()
    const currentRow = current as unknown as { autopay_card_enabled: boolean | null; autopay_stripe_payment_method_id: string | null } | null
    if (currentRow && !currentRow.autopay_card_enabled && !currentRow.autopay_stripe_payment_method_id) {
      return { ok: true }
    }
    console.warn(`[card-autopay] disable skipped for account ${accountId} — the card on file changed concurrently (likely a re-enrollment mid-flight)`)
    return { ok: false, error: "Autopay's card on file changed at the same moment — please check the current status and try again." }
  }

  if (stripe && paymentMethodId) {
    try {
      await stripe.paymentMethods.detach(paymentMethodId)
    } catch (err) {
      // Non-fatal — the card may already be detached (e.g. a prior partial
      // failure). The DB flag is already off either way; a stale
      // Stripe-side attachment with autopay_card_enabled=false can never be
      // charged by our own code, which only ever checks the DB flag.
      console.warn(`[card-autopay] detach failed for account ${accountId} (continuing):`, err)
    }
  }

  try {
    await supabaseAdmin.from("action_log").insert({
      actor,
      action_type: "card_autopay_disabled",
      table_name: "accounts",
      record_id: accountId,
      account_id: accountId,
      summary: actor === "client" ? "Card autopay turned off by the client" : `Card autopay turned off from the CRM (${actor})`,
    })
  } catch { /* audit is best-effort */ }

  // Clear the way for a future re-enrollment to notify staff again — a
  // disable always means "the next enable is a fresh event," never a
  // resubmission-only case like this pattern's siblings elsewhere.
  try {
    const { retireCardAutopayEnabledNote } = await import("@/lib/portal/chat-events")
    // deletedBy is a uuid column — pass the real dashboard user's id when a
    // staff member did this, never the "dashboard:<name>" actor label (same
    // class of bug as the portal_messages.sender_id fix). Falls back to the
    // system actor for the client's own self-service disable.
    await retireCardAutopayEnabledNote({ accountId, deletedBy: deletedByUserId })
  } catch (err) {
    // Best-effort, but silent here means a future re-enrollment can dedupe
    // against a note that was never actually retired (QA-Tester finding,
    // council review 2026-08-30).
    console.warn(`[card-autopay] retireCardAutopayEnabledNote failed for account ${accountId}:`, err instanceof Error ? err.message : String(err))
  }

  return { ok: true }
}
