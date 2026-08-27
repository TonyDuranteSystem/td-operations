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
 * ⛔ HOW FAR A PLAN'S PARTS MAY DIFFER FROM THE OFFER'S GROSS — ONE constant, shared by the
 * authoring screen and by every consumer that judges the stored plan.
 *
 * It exists because the Create Offer dialog shipped its own looser threshold (0.5) while the
 * engine used 0.01, and there is no server-side plan-vs-gross crosscheck behind the dialog. A
 * three-way split of a fee that does not divide (3500 → 1166.66 × 3 = 3499.98) passed the gate
 * and was then refused by every consumer: the offer page hid the payment controls, the contract
 * could not state an amount, and signing billed the WHOLE fee. A gate looser than the thing it
 * guards is not a gate — so the number now lives in one place and cannot drift again.
 *
 * 0.01 = one cent. Splitting a fee into thirds leaves sub-picocent float drift, which is four
 * orders of magnitude below this; a real one-cent authoring error is refused.
 */
export const PLAN_TOTAL_TOLERANCE = 0.01

/** True when a plan's parts add up to the offer's gross, within the shared tolerance. */
export function planTotalMatchesGross(planSum: number, gross: number): boolean {
  return Math.abs(planSum - gross) <= PLAN_TOTAL_TOLERANCE
}

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
  if (!planTotalMatchesGross(total, args.offerGross)) {
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
 * The STANDARD 50/50 split a client can choose at pay-time (Antonio, 2026-08-27) — distinct from
 * the fully staff-authored plan the rest of this file otherwise assumes. Pure: given the final
 * contract price (already resolved for whichever option a multi-option offer's client picked)
 * and today's date, returns the raw two-part plan shape ready for `validatePaymentPlan`.
 *
 * `todayIso` is explicit, not read from `new Date()` inside — this codebase's own pattern for
 * date-based logic (see `duePartsToAutoRaise`), so a test can assert "30 days from a fixed date"
 * without mocking the system clock.
 *
 * Splits by SUBTRACTION, not by halving twice: part 2 is `gross - part1`, so the two parts always
 * sum EXACTLY to the contract price even on an odd-cent gross (same reasoning
 * `PLAN_TOTAL_TOLERANCE` exists to guard against elsewhere in this file).
 */
export function buildSplitPaymentPlan(gross: number, currency: string, todayIso: string): unknown[] {
  const round2 = (n: number) => Math.round(n * 100) / 100
  const half = round2(gross / 2)
  const due = new Date(`${todayIso}T00:00:00Z`)
  due.setUTCDate(due.getUTCDate() + 30)
  return [
    { seq: 1, amount: half, currency, trigger: { kind: "signing" } },
    { seq: 2, amount: round2(gross - half), currency, trigger: { kind: "date", date: due.toISOString().slice(0, 10) } },
  ]
}

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
