import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { accessCodeError } from "@/lib/esign/access-guard"
import { resolveBillableSelection } from "@/lib/payments/billable-selection"
import { computeOfferPayable } from "@/lib/offers/compute-offer-totals"
import { validatePaymentPlan, buildSplitPaymentPlan } from "@/lib/offers/payment-plan"
import { getOfficeDateString } from "@/lib/portal/office-hours"

export const dynamic = "force-dynamic"

/**
 * POST /api/offers/choose-payment-split
 *
 * The client's own choice — pay in full, or split the setup fee 50/50 over 30 days (5% fee
 * on both halves) — made BEFORE signing, not after.
 *
 * ⛔ REWRITTEN (council review, 2026-08-27, second pass) after the first version fabricated
 * paid revenue: it let the client choose AFTER signing, but signing already mints a real,
 * full-amount invoice (offer-signed webhook → decideSigningBill → createTDInvoice). A later
 * card payment for half never reconciled that invoice — card-fee booking saw a mismatch and
 * gave up, then activation's settle-full path marked the WHOLE original invoice "Paid" anyway.
 * Four independent reviewers traced this as the deterministic outcome on every real use, not
 * an edge case.
 *
 * THE FIX: move the choice to before signing, mirroring how a multi-option offer's package pick
 * already has to happen before signing (lib/offers/package-pick.ts, app/api/offers/pick-package
 * /route.ts) — the same access-code check, the same compare-and-swap lock pattern, and the same
 * status refusal list. By the time signing happens, `payment_plan` is already correctly resolved
 * (or correctly null), so the EXISTING, already-proven decideSigningBill/createTDInvoice path
 * mints a correctly-sized, correctly-tranche-tagged invoice from the very first mint — no changes
 * needed there. The client still pays every part themselves, through the ordinary checkout flow;
 * this route never charges a card and never touches Stripe.
 *
 * Corrections from the review that a naive "just move it earlier" port would have missed:
 *  - `selected_services` MUST be threaded through explicitly (senior-engineer + ai-architect +
 *    bug-hunter, independently): a client's optional-add-on choice isn't persisted until they
 *    click through to sign, so computing the split against the offer's STORED selection here
 *    would silently split the wrong (usually smaller) total. The caller passes its live,
 *    in-memory selection; `resolveBillableSelection` still refuses to trust it once the offer is
 *    actually signed (unchanged, existing protection).
 *  - The "full" branch gets the SAME compare-and-swap as "split" (bug-hunter): two tabs racing
 *    "full" vs "split" must not let an unconditional "full" write silently survive underneath an
 *    already-locked split.
 *  - `card_fee_rate` is NOT pinned here (finance-auditor): pinning it at the pre-sign click
 *    persists whatever the global kill-switch resolves to AT THAT INSTANT for the deal's entire
 *    life, which is a new risk this route didn't have when the rate was pinned per-invoice,
 *    after signing. The existing signing webhook already pins the rate at the moment that
 *    matters (offer-signed/route.ts's `pinnedRateForInheritance`) — left completely alone.
 *  - Status check is an explicit allowlist of the three real pre-signing statuses that exist in
 *    this codebase (draft/sent/viewed — `accepted` is in the DB's historical CHECK constraint
 *    but no code path ever writes it), not a hand-rolled negation of signed/completed — mirrors
 *    pick-package's own four-way refusal (signed/completed/expired/superseded) so a stale or
 *    revised-away link is rejected the same way.
 *
 * ⛔ SECOND ADVERSARIAL PASS (bug-hunter, full E2E QA, 2026-08-27) found the route's OWN write
 * still left two ways for the locked choice to drift from the truth after this point:
 *  - BOTH branches now persist `selected_services` in the SAME write as the choice, not just the
 *    "split" branch's price computation. Without this, the offer page's post-choice reload
 *    (`loadOffer`) found no stored selection yet, silently fell back to the RECOMMENDED defaults,
 *    and a client who had actually picked a different set of optional add-ons saw their own
 *    choice reverted right after locking a plan sized for the ORIGINAL selection — a signed
 *    contract could then state a fee and an installment schedule that disagree with each other.
 *  - The "full" branch now explicitly clears `payment_plan: null`. A staff-authored plan and this
 *    toggle are only kept mutually exclusive by the Create Offer dialog's UI (`lib/operations/
 *    offers.ts` says so explicitly) — nothing stops a later `offer_update` call from attaching a
 *    staff plan to an offer that also has this toggle on. Without this line, a client explicitly
 *    choosing "pay in full" would still be billed only the stale plan's first part at signing.
 *
 * Body: { token: string, code: string, choice: 'full' | 'split', selected_services?: string[] }
 * Returns: { ok: true, choice, plan? } — the caller then proceeds to the contract/sign page,
 * where the existing plan-aware invoicing takes over unchanged.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}))
    const { token, code, choice, selected_services: requestedSelection } = body as {
      token?: string
      code?: string
      choice?: "full" | "split"
      selected_services?: string[]
    }

    if (!token) {
      return NextResponse.json({ error: "Missing token" }, { status: 400 })
    }
    if (choice !== "full" && choice !== "split") {
      return NextResponse.json({ error: "choice must be 'full' or 'split'" }, { status: 400 })
    }

    // eslint-disable-next-line no-restricted-syntax -- allow_split_payment_choice/payment_choice_made_at postdate the generated types (migrations 20260827-1200, 20260827-1900)
    const { data: offer, error: oErr } = await supabaseAdmin
      .from("offers")
      .select("token, access_code, status, services, cost_summary, selected_services, currency, credit_amount, allow_split_payment_choice, payment_plan, payment_choice_made_at, packages, package_locked_at" as never)
      .eq("token", token)
      .maybeSingle()

    if (oErr || !offer) {
      return NextResponse.json({ error: "Offer not found" }, { status: 404 })
    }

    const o = offer as unknown as {
      access_code: string | null
      status: string | null
      services: unknown
      cost_summary: unknown
      selected_services: unknown
      currency: string | null
      credit_amount: number | string | null
      allow_split_payment_choice: boolean | null
      payment_plan: unknown
      payment_choice_made_at: string | null
      packages: unknown
      package_locked_at: string | null
    }

    const codeErr = accessCodeError(req, {
      token,
      expected: o.access_code || "",
      provided: code || "",
      isPreview: false,
    })
    if (codeErr) {
      return NextResponse.json({ error: codeErr.error }, { status: codeErr.status })
    }

    if (!o.allow_split_payment_choice) {
      return NextResponse.json({ error: "This offer does not offer a payment choice." }, { status: 400 })
    }

    // Explicit allowlist of the real pre-signing statuses (mirrors pick-package's own
    // signed/completed/expired/superseded refusal, expressed the other way round) — a stale
    // link on an already-decided, already-signed, expired, or revised-away offer is refused,
    // not silently actioned.
    if (o.status !== "draft" && o.status !== "sent" && o.status !== "viewed") {
      return NextResponse.json(
        { error: `This offer is ${o.status} — a payment choice can no longer be made.` },
        { status: 409 },
      )
    }

    if (o.payment_choice_made_at != null) {
      return NextResponse.json({ error: "A payment choice was already made for this offer." }, { status: 409 })
    }

    // A multi-option offer's picker gates the payment-choice UI behind the package pick on the
    // normal browser path, but this endpoint is public and token+code only — a direct call could
    // otherwise lock a plan sized against the offer's top-level services/cost_summary, which are
    // only ever PLACEHOLDERS on a package offer until a package is actually picked (see
    // revise-copy.ts's own comment on the same fact). Refuse rather than compute against a number
    // that was never the real price.
    if (Array.isArray(o.packages) && o.packages.length > 0 && !o.package_locked_at) {
      return NextResponse.json(
        { error: "This offer has multiple options — pick one first." },
        { status: 400 },
      )
    }

    // Computed ONCE, used by both branches: the client's optional-add-on selection isn't
    // persisted to the offer row until now (it used to only happen at the "Accept & Sign" click),
    // so BOTH branches must write it in the same update as the choice itself — see the file header
    // for the exact failure this closes.
    const selectedServices = resolveBillableSelection({
      status: o.status,
      storedSelection: o.selected_services,
      requestedSelection,
    })

    if (choice === "full") {
      // Same atomic guard as the split branch below — a racing "split" request must not be
      // silently overwritten by an unconditional "full" write. payment_plan is explicitly
      // cleared: a staff-authored plan and this toggle are only kept apart by the Create Offer
      // dialog's UI, not the database, so a client choosing "full" must not be left billed
      // against whatever stale plan happened to already be on the row (file header).
      const { data: claimed, error: writeErr } = await supabaseAdmin
        .from("offers")
        .update({
          payment_choice_made_at: new Date().toISOString(),
          payment_plan: null,
          selected_services: selectedServices,
        } as never)
        .eq("token", token)
        .is("payment_choice_made_at" as never, null)
        .select("token")

      if (writeErr) {
        return NextResponse.json({ error: writeErr.message }, { status: 500 })
      }
      if (!claimed || claimed.length === 0) {
        return NextResponse.json({ error: "A payment choice was already made for this offer." }, { status: 409 })
      }
      return NextResponse.json({ ok: true, choice: "full" })
    }

    // choice === "split"
    const totals = computeOfferPayable({
      services: o.services,
      cost_summary: o.cost_summary,
      selected_services: selectedServices,
      currency: o.currency,
      credit_amount: o.credit_amount,
      payment_plan: null, // there is none yet — this route is the one about to create it
    })

    if (totals.gross <= 0) {
      return NextResponse.json({ error: "Could not determine the amount to split." }, { status: 400 })
    }

    const currency = totals.currency === "EUR" ? "EUR" : "USD"
    const rawPlan = buildSplitPaymentPlan(totals.gross, currency, getOfficeDateString())
    const validated = validatePaymentPlan(rawPlan)
    if (!validated.ok || !validated.plan) {
      return NextResponse.json({ error: validated.errors.join(" ") || "Could not build a valid payment plan." }, { status: 500 })
    }

    const { data: claimed, error: writeErr } = await supabaseAdmin
      .from("offers")
      .update({
        payment_plan: validated.plan,
        payment_choice_made_at: new Date().toISOString(),
        selected_services: selectedServices,
      } as never)
      .eq("token", token)
      .is("payment_choice_made_at" as never, null)
      .select("token")

    if (writeErr) {
      return NextResponse.json({ error: writeErr.message }, { status: 500 })
    }
    if (!claimed || claimed.length === 0) {
      return NextResponse.json({ error: "A payment choice was already made for this offer." }, { status: 409 })
    }

    return NextResponse.json({ ok: true, choice: "split", plan: validated.plan })
  } catch (err) {
    console.error("[choose-payment-split] Error:", err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Internal error" },
      { status: 500 },
    )
  }
}
