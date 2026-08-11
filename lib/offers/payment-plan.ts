/**
 * Offer payment plans — a setup fee paid in parts.
 *
 * Pure. THE authority on a plan's shape: the database column is jsonb, so this file is the only
 * thing standing between a typo and a client being billed the wrong amount. WS-C item 2,
 * dev job `c0a61e44`.
 *
 * ── THE THREE CONSTRAINTS FROM THE APPROVED DESIGN, ENFORCED HERE ────────────────────────
 *
 *  1. N PARTS, NOT TWO. A list. The screen may only offer two today; adding a third must never
 *     need a migration or a code change beyond the UI. Two slots in the schema would have been
 *     the shortcut that costs a rebuild.
 *
 *  2. TRIGGERS ARE DATA, AND THERE IS NO DATE ENGINE. Each part carries {signing | event | date
 *     | manual}. "manual" is always available. A DATE-triggered part is something a human is
 *     REMINDED of — nothing fires on a schedule, and minting stays a click. That limit was
 *     accepted explicitly when the design was approved: quietly adding a scheduler later would
 *     break the standing rule that nothing bills a client unattended.
 *
 *  3. ONE CURRENCY PER PLAN, REFUSED AT SAVE. Not a warning, not a coercion. The credit engine
 *     nets same-currency only, the bank matcher compares same-currency only, and the activation
 *     amount is a single figure — so a mixed-currency plan would fail three layers down, far from
 *     the person who typed it, with no useful message. Refusing at the point of entry is the only
 *     place the error can be explained.
 *
 * ⛔ VOCABULARY. `internal_label` is INTERNAL. Client-facing text for a split setup fee must never
 * say "instalment" — that word belongs to the renewal contract, and the separation from the annual
 * Jan/Jun machinery has to hold in the words as well as the data. Antonio's own wording is
 * "Partial Payment". `clientFacingPartLabel` below is the only sanctioned client-facing phrasing.
 */

export type TrancheTriggerKind = "signing" | "event" | "date" | "manual"

export interface TrancheTrigger {
  kind: TrancheTriggerKind
  /**
   * For kind='event': the name of a WIRED business event — one that code actually dispatches.
   * See `WIRED_TRANCHE_EVENTS`; while that registry is empty this field cannot be stored.
   */
  event?: string
  /** For kind='date': ISO date. A REMINDER, never a scheduler — see the header. */
  date?: string
  /**
   * For kind='manual': what the client is waiting for, in plain words — e.g.
   * "when your bank account is opened". ⚠️ CLIENT-VISIBLE: this text renders on the client's
   * schedule line (architect ruling, 2026-08-11 — a generic "the agreed step" tells a client
   * nothing about when they owe money, and these are the words the author chose). Write it FOR
   * the client; do not put internal vendor chatter here — `internal_label` exists for that.
   *
   * Deliberately FREE TEXT rather than a named event: the system has no idea when a bank
   * account opens, so an event name would imply a mechanism that does not exist.
   */
  label?: string
}

export interface PaymentPlanPart {
  /** 1-based position. Parts are ordered by this and it must be contiguous from 1. */
  seq: number
  amount: number
  currency: string
  trigger: TrancheTrigger
  /** Staff-facing only. Never rendered to a client. */
  internal_label?: string
}

export type PaymentPlan = PaymentPlanPart[]

/**
 * ⛔ EVENTS A TRANCHE MAY WAIT ON — AND THE REGISTRY IS DELIBERATELY EMPTY. (Architect ruling,
 * 2026-08-10.)
 *
 * An event name in stored data is a PROMISE THAT SOMETHING FIRES IT. A later session that finds
 * one will reasonably assume a dispatcher exists and build on top of that assumption — which is
 * exactly how a feature comes to depend on a mechanism nobody wrote. So a name may only appear
 * here once code genuinely dispatches on it, and until then an `event` trigger is refused at
 * save time rather than accepted and left waiting for ever.
 *
 * WHAT THIS REPLACED, and why it was wrong: "bank_account_opened", "ein_received" and
 * "company_formed" were listed here as if interchangeable. They are not. The system has NO
 * notion of a bank account opening — formation no longer even creates a banking service delivery,
 * because banking is self-service — so that one is purely Antonio's judgement and now lives as a
 * `manual` trigger carrying his own words in `label`. The other two DO correspond to real moments
 * in the system (an EIN being recorded, a formation being confirmed), but nothing dispatches a
 * tranche raise from either of them yet, so listing them here would have been the same false
 * promise in a more plausible costume.
 *
 * TO WIRE ONE, all three in the same change: add the name here, dispatch it from the real moment,
 * and add its client-facing wording below (English — this feature is English-only). Ready copy
 * candidates when someone does the work:
 *   ein_received   → "when your EIN is issued" / "al rilascio dell'EIN"
 *   company_formed → "when your company is formed" / "alla costituzione della società"
 */
export const WIRED_TRANCHE_EVENTS: readonly string[] = []

export interface PlanValidation {
  ok: boolean
  /** Plain-English reasons, shown to whoever is authoring the plan. */
  errors: string[]
  plan?: PaymentPlan
}

function isFiniteAmount(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v > 0
}

/**
 * Validate and normalise a plan as authored.
 *
 * Refuses rather than repairs. A plan is money a client has agreed to: silently coercing a
 * malformed one is how a wrong figure reaches a contract.
 */
export function validatePaymentPlan(raw: unknown): PlanValidation {
  const errors: string[] = []

  if (raw == null) return { ok: true, errors: [], plan: undefined } // no plan = single payment

  if (!Array.isArray(raw)) {
    return { ok: false, errors: ["A payment plan must be a list of parts."] }
  }
  if (raw.length === 0) {
    return { ok: false, errors: ["A payment plan needs at least one part — or no plan at all."] }
  }
  if (raw.length === 1) {
    errors.push("A one-part plan is just a single payment — leave the plan empty instead.")
  }

  const parts: PaymentPlanPart[] = []
  const currencies = new Set<string>()

  raw.forEach((entry, i) => {
    const at = `Part ${i + 1}`
    if (!entry || typeof entry !== "object") {
      errors.push(`${at}: not a part.`)
      return
    }
    const p = entry as Record<string, unknown>

    if (!isFiniteAmount(p.amount)) {
      errors.push(`${at}: needs an amount greater than zero.`)
    }

    const currency = typeof p.currency === "string" ? p.currency.trim().toUpperCase() : ""
    if (!currency) errors.push(`${at}: needs a currency.`)
    else currencies.add(currency)

    const trigger = (p.trigger ?? {}) as Record<string, unknown>
    const kind = trigger.kind as TrancheTriggerKind | undefined
    if (kind !== "signing" && kind !== "event" && kind !== "date" && kind !== "manual") {
      errors.push(`${at}: needs a trigger — on signing, on an event, on a date, or when you say so.`)
    }
    if (kind === "event") {
      const event = typeof trigger.event === "string" ? trigger.event : ""
      if (!WIRED_TRANCHE_EVENTS.includes(event)) {
        // Refused rather than stored-and-ignored. A part waiting on an event nothing fires would
        // sit unbilled indefinitely, and the offer would look complete while a payment silently
        // never came due.
        errors.push(
          WIRED_TRANCHE_EVENTS.length === 0
            ? `${at}: nothing in the system fires an event yet, so a part cannot wait on one. ` +
              `Use "when you say so" and write what you are waiting for (e.g. "when the bank account opens") — ` +
              `you raise that part yourself when it happens.`
            : `${at}: "${event || "(no event)"}" is not an event the system fires. ` +
              `Ones that are: ${WIRED_TRANCHE_EVENTS.join(", ")}.`,
        )
      }
    }
    if (kind === "date") {
      const date = typeof trigger.date === "string" ? trigger.date : ""
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        errors.push(`${at}: a date trigger needs a date (YYYY-MM-DD).`)
      } else {
        // The regex admits impossible dates ("2026-13-45") which would then render raw on the
        // client's schedule (council, 2026-08-11). A date the calendar rejects is refused here,
        // where the author can fix it.
        const d = new Date(`${date}T00:00:00Z`)
        const roundTrips =
          !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === date
        if (!roundTrips) {
          errors.push(`${at}: "${date}" is not a real calendar date.`)
        }
      }
    }

    parts.push({
      seq: typeof p.seq === "number" ? p.seq : i + 1,
      amount: isFiniteAmount(p.amount) ? p.amount : 0,
      currency,
      trigger: {
        kind: (kind ?? "manual") as TrancheTriggerKind,
        ...(typeof trigger.event === "string" && trigger.event ? { event: trigger.event } : {}),
        ...(typeof trigger.date === "string" && trigger.date ? { date: trigger.date } : {}),
        ...(typeof trigger.label === "string" && trigger.label.trim()
          ? { label: trigger.label.trim() }
          : {}),
      },
      ...(typeof p.internal_label === "string" && p.internal_label
        ? { internal_label: p.internal_label }
        : {}),
    })
  })

  // ⛔ CONSTRAINT 3 — one currency, refused here and nowhere else.
  if (currencies.size > 1) {
    errors.push(
      `A plan must be in ONE currency; this one mixes ${Array.from(currencies).sort().join(" and ")}. ` +
        `Credit, bank matching and activation are all single-currency, so a mixed plan breaks further ` +
        `down where the error means nothing.`,
    )
  }

  // Sequence numbers must be contiguous from 1: the mint action, the lineage index and the
  // client-facing "part 2 of 3" all count on it.
  const seqs = parts.map((p) => p.seq).sort((a, b) => a - b)
  const expected = parts.map((_, i) => i + 1)
  if (JSON.stringify(seqs) !== JSON.stringify(expected)) {
    errors.push(`Parts must be numbered 1 to ${parts.length} with no gaps or repeats.`)
  }

  // Exactly one part may be triggered by signing — that part is the activation anchor, and two
  // anchors would make "is this deal live?" ambiguous.
  const signingParts = parts.filter((p) => p.trigger.kind === "signing")
  if (signingParts.length > 1) {
    errors.push("Only one part can be due on signing — that part is what activates the deal.")
  }

  if (errors.length > 0) return { ok: false, errors }
  return { ok: true, errors: [], plan: parts.sort((a, b) => a.seq - b.seq) }
}

/**
 * ⛔ A PLAN IS REFUSED ON AN OFFER THAT CARRIES A REFERRAL PARTNER (architect ruling, 2026-08-10).
 *
 * Not a limitation of taste — a consequence of a defect I found and could not fix here. Activation
 * credits the WHOLE commission the moment the first payment lands, because the referral credit-note
 * issuer can only ever key one note per referral. That is correct for every offer without a plan,
 * and wrong the first time a plan meets a partner: the referrer is paid in full on part one, and if
 * part two never arrives, TD has paid commission on revenue it never received — recoverable only by
 * editing a credit note the referrer can already see.
 *
 * The interim guard (suppress the automatic credit, raise a card for hand settlement) covers the
 * case where a plan and a referrer end up on the same deal ANYWAY. This refusal stops that
 * happening at the point of authoring instead, so the hand-settlement path is a safety net rather
 * than the normal route. Same pattern as the price-difference refusal and the empty event registry:
 * excluded and loud beats included and wrong.
 *
 * ── THE LIFT ORDER, and it is an ORDER ────────────────────────────────────────────────────
 *
 * 1. Job `a5e61a46` lands — commission timing becomes recorded DATA rather than an assumption
 *    hardcoded to activation. That job carries all four parts: timing recorded (null reading as
 *    activation, so every existing offer is unchanged); the issuer accepting a caller-supplied key
 *    while still producing today's key when none is passed; the referral row ACCUMULATING and only
 *    reaching "credited" when the recorded commission is fully credited; and the self-heal reading
 *    recorded intent instead of inferring it from an empty field.
 * 2. THEN delete this check.
 * 3. THEN flip `ISSUER_SUPPORTS_PER_PART_KEY` in `tranche-commission.ts`.
 *
 * Never out of order, and verify each step rather than assuming the previous one landed.
 *
 * ── WHY A REFUSAL WAS THE HONEST INTERIM ANSWER, not a shortcut ───────────────────────────
 *
 * It refuses at AUTHORING — before any money moves, before a client sees a figure, before a
 * partner is owed anything. And it costs nothing today: no production offer carries both a plan
 * and a referrer, so nothing that exists is blocked by it.
 *
 * The alternative considered and rejected was a half-built accrual — crediting per part on top of
 * machinery that cannot key a second credit. That would have been a patch: it would have looked
 * like the feature working while silently under-paying a partner, which is the failure mode that
 * leaves nothing looking wrong afterwards. A refusal is visible the moment someone hits it.
 *
 * ── ONE FURTHER OPTION, REJECTED, AND THE REASON IS THE POINT ─────────────────────────────
 *
 * Teaching the self-heal to skip a plan-bearing offer was the smaller-looking change and it was
 * rejected as the WRONG SHAPE rather than the wrong size: the self-heal is not broken because it
 * does not know about plans, it is broken because it INFERS INTENT FROM AN EMPTY FIELD. A skip
 * condition stacks a second guess on the first, and the next thing that legitimately defers a
 * commission trips it again. That is why `a5e61a46` makes intent explicit instead.
 *
 * ⛔ STAFF-FACING ONLY, and verified so (2026-08-11): this fires inside offer creation, which
 * only the CRM dialog and the staff tool call — no client route reaches it, no client page
 * renders any referrer field, and Antonio's constraint is explicit: THE CLIENT HAS NOTHING TO DO
 * WITH THE REFERRER. A client must never learn a referrer exists, so no version of this message
 * may ever be surfaced on a client page. English only (Antonio, 2026-08-11).
 */
export function refusePlanWithReferralPartner(
  hasReferrer: boolean,
  /**
   * Names WHICH offer refused — the client's name at creation, the token on an update. Two real
   * referred offers are live and unsigned right now, so a staff member will meet this refusal on
   * a real deal soon (counselor, 2026-08-11): a message that names the deal and says what to do
   * is actionable; one that only says "refused" sends them hunting.
   */
  subject?: string,
): string | null {
  if (!hasReferrer) return null
  const which = subject ? `Offer "${subject}" has a referrer` : "This offer has a referrer"
  return (
    `${which}, so it cannot be sold with a Partial Payment: the commission would ` +
    "be credited in full on the first payment. Either drop the plan, or remove the referrer " +
    "(and settle their commission by hand as the parts are paid) — then save again."
  )
}

/** Total of every part — what the client has actually committed to. */
export function planTotal(plan: PaymentPlan): number {
  return Math.round(plan.reduce((sum, p) => sum + p.amount, 0) * 100) / 100
}

/** A plan's single currency. Safe because validation refuses a mixed plan. */
export function planCurrency(plan: PaymentPlan): string {
  return plan[0]?.currency ?? "USD"
}

/**
 * The part invoiced at signing, if any — the ACTIVATION ANCHOR.
 *
 * A plan without a signing part is legal (everything manual) but then nothing activates on
 * signing, which is a deliberate authoring choice rather than a bug.
 */
export function signingPart(plan: PaymentPlan): PaymentPlanPart | null {
  return plan.find((p) => p.trigger.kind === "signing") ?? null
}

/** Parts that are NOT due at signing — the ones a human mints later. */
export function laterParts(plan: PaymentPlan): PaymentPlanPart[] {
  return plan.filter((p) => p.trigger.kind !== "signing")
}

/** Client wording per WIRED event. Empty while the registry is — see `WIRED_TRANCHE_EVENTS`. */
const EVENT_WORDING: Record<string, string> = {}

/**
 * Render an ISO date the way every other client-facing date on the offer pages renders —
 * "1 September 2026" — rather than leaking raw ISO to a client. Matches the pages' own
 * `formatDate` (day, month name, year, UTC) instead of inventing a second format; UTC on purpose,
 * same as the pages, so the date never shifts by timezone.
 */
function clientFacingDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`)
  if (Number.isNaN(d.getTime())) return iso
  const months = ["January","February","March","April","May","June","July","August","September","October","November","December"]
  return `${d.getUTCDate()} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()}`
}

/**
 * What a CLIENT is told about when a part is due. ENGLISH ONLY (Antonio, 2026-08-11) — the
 * earlier Italian register is withdrawn, and this feature has exactly one set of words.
 *
 * ⛔ Still the only sanctioned client-facing phrasing, and it never says "instalment" — that word
 * belongs to the renewal contract, and the separation from the annual Jan/Jun machinery has to
 * hold in the words as well as the data.
 *
 * A MANUAL part renders THE STORED WORDS (`trigger.label`) when present — the author's own
 * description of what the client is waiting for, e.g. "when your bank account is opened"
 * (architect ruling: a generic "the agreed step" tells the client nothing). The label is
 * client-visible by contract now; the generic phrase survives only as the fallback for a part
 * authored without one.
 */
export function clientFacingPartLabel(part: PaymentPlanPart, totalParts: number): string {
  const position = `Part ${part.seq} of ${totalParts}`
  switch (part.trigger.kind) {
    case "signing":
      return `${position}, due on signing`
    case "event":
      return `${position}, due ${EVENT_WORDING[part.trigger.event ?? ""] ?? "when the agreed step is complete"}`
    case "date":
      return `${position}, due by ${clientFacingDate(part.trigger.date ?? "")}`
    case "manual":
    default: {
      const label = part.trigger.label
      if (!label) return `${position}, due when the agreed step is complete`
      // The author's words are a CONDITION, not always a phrase that can follow "due" directly —
      // "Bank account opened" rendered as the non-sentence "due Bank account opened" (gate
      // defect, 2026-08-11). Fix the JOINING, never the author's text: words that already begin
      // with a connective read straight through; anything else gets the colon form, verbatim.
      const startsConnected = /^(when|once|after|upon|as soon as|by|within|in|on)\b/i.test(label)
      return startsConnected
        ? `${position}, due ${label}`
        : `${position} — due once complete: ${label}`
    }
  }
}

/**
 * The whole plan as lines a CLIENT reads, in order — the schedule's wording, in one place.
 *
 * Formatting the money is the caller's job (each surface already owns its own symbol and locale
 * rules). What is centralised here is the SENTENCE, so the offer page, the signed contract and
 * the portal cannot describe the same agreement three different ways — and so the ban on the
 * renewal vocabulary holds everywhere at once instead of per surface.
 */
export function clientFacingSchedule(
  plan: PaymentPlan,
): Array<{ seq: number; amount: number; currency: string; label: string }> {
  return plan.map((p) => ({
    seq: p.seq,
    amount: p.amount,
    currency: p.currency,
    label: clientFacingPartLabel(p, plan.length),
  }))
}

export interface SigningBill {
  /** What to invoice NOW. The commitment total when there is no plan. */
  amount: number
  /** The invoice line's description. */
  description: string
  /** Lineage for the invoice, or null when this is an ordinary single-payment offer. */
  tranche: { offerToken: string; seq: number } | null
  /** `setup_tranche` for a part, null for an ordinary invoice (which keeps today's behaviour). */
  category: "setup_tranche" | null
  /**
   * Set when a stored plan could not be used. The signing MUST still proceed — the client has
   * already signed and the signature is stored — so the caller bills the whole fee and logs
   * this. Minting nothing would leave a signed deal with no bill at all, which is worse.
   */
  planIgnored: string | null
}

/**
 * WHAT SIGNING BILLS — extracted from the offer-signed webhook so it is testable.
 *
 * The webhook is a route with a database, an activation row, a chat event and a PDF in it; the
 * decision about how much money to ask a client for should not be reachable only by firing that
 * whole thing. Same reasoning as `decideInvoiceAtSigning` and the revised-offer copy list: the
 * rule lives in a pure function, the route imports it, and the two cannot drift.
 */
export function decideSigningBill(args: {
  rawPlan: unknown
  offerToken: string
  /** The whole commitment, from the offer amount engine. */
  offerGross: number
  /** The offer's resolved currency, from the engine. Omitted = skip the currency crosscheck. */
  offerCurrency?: string
  /** The description an ordinary offer would use. */
  baseDescription: string
}): SigningBill {
  const ordinary: SigningBill = {
    amount: args.offerGross,
    description: args.baseDescription,
    tranche: null,
    category: null,
    planIgnored: null,
  }

  if (args.rawPlan == null) return ordinary

  const parsed = validatePaymentPlan(args.rawPlan)
  if (!parsed.ok || !parsed.plan) {
    return { ...ordinary, planIgnored: parsed.errors.join(" ") }
  }

  // ⛔ THE PLAN MUST AGREE WITH ITS OFFER, HERE TOO (council blocker, 2026-08-11). Structural
  // validity is not agreement: a plan can be internally perfect while its offer's total drifted
  // (a revision changed the services) or its currency never matched. Every other rail refuses
  // that shape — the pages hide the pay controls, checkout 400s — but this function used to bill
  // part one anyway, silently, minting an invoice of record for an amount nobody agreed to, in a
  // currency that could be wrong. Worse: the pages tell the client "do not pay" while the portal
  // mirror shows a live payable invoice for the same deal.
  //
  // The degrade is the documented one, and it is deliberate: bill the WHOLE fee, loudly. By this
  // point the signature is stored, and a signed deal with no bill is worse than one Antonio
  // amends — the same reasoning as the structurally-invalid case above.
  const total = planTotal(parsed.plan)
  if (Math.abs(total - args.offerGross) > 0.01) {
    return {
      ...ordinary,
      planIgnored:
        `The plan adds up to ${total} but the offer totals ${args.offerGross} — billed the whole ` +
        `fee instead of part one. Fix whichever is wrong, then void and re-raise.`,
    }
  }
  if (args.offerCurrency && planCurrency(parsed.plan).toUpperCase() !== args.offerCurrency.toUpperCase()) {
    return {
      ...ordinary,
      planIgnored:
        `The plan is in ${planCurrency(parsed.plan)} but the offer is in ${args.offerCurrency} — ` +
        `billed the whole fee instead of part one. Fix whichever is wrong, then void and re-raise.`,
    }
  }

  const signing = signingPart(parsed.plan)
  // A plan where nothing is due on signing is legal — every part is raised by hand later. Zero
  // is the honest answer and the caller's invoice predicate turns it into "no invoice", where
  // falling back to the commitment total would bill the client for money not yet due.
  if (!signing) {
    return {
      amount: 0,
      description: args.baseDescription,
      tranche: null,
      category: null,
      planIgnored: null,
    }
  }

  return {
    amount: signing.amount,
    description: trancheInvoiceDescription(signing, parsed.plan.length, args.baseDescription),
    tranche: { offerToken: args.offerToken, seq: signing.seq },
    category: "setup_tranche",
    planIgnored: null,
  }
}

/**
 * THE NAME for a part of a split setup fee. ENGLISH ONLY — Antonio's ruling, 2026-08-11:
 * "I don't want a fucking nothing in italian. Luca and I work in english." This SUPERSEDES his
 * earlier approval of an Italian label; every client- and staff-facing string in the payment-plan
 * feature ships in English. (The platform's EXISTING Italian — the offer hero, the bilingual
 * emails — is untouched; the ruling is about THIS feature's copy.)
 *
 * "Partial Payment" is his own wording from Domenico's invoice. Never the renewal contract's
 * vocabulary — see the ban above, which stays armed precisely so no future session reintroduces
 * what has now been ruled out twice.
 */
export const PARTIAL_PAYMENT_LABEL = "Partial Payment"

/**
 * The description that goes ON the invoice for a part. English, like every other invoice
 * description in the system — and like every other string in this feature (Antonio, 2026-08-11).
 */
export function trancheInvoiceDescription(
  part: PaymentPlanPart,
  totalParts: number,
  serviceLabel: string,
): string {
  return `${serviceLabel} — ${PARTIAL_PAYMENT_LABEL} (part ${part.seq} of ${totalParts})`
}
