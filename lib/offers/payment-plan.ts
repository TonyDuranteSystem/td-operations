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
   * For kind='manual': what the human is waiting for, in their own words
   * (e.g. "Bank account opened (Relay)"). Staff-facing.
   *
   * This is where "when the bank account opens" belongs, and it is deliberately FREE TEXT rather
   * than a named event: the system has no idea when a bank account opens, so a name would imply
   * a mechanism that does not exist.
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
 * and add its client-facing wording in BOTH languages below. Copy ready for the two plausible
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
 * LIFTED BY: the referral-issuer job (a caller-supplied key + an accumulating referral row). When
 * that lands, delete this check and flip the accrual interlock — in that order, and verify both.
 *
 * The message travels to whoever is authoring, in their language, and says what to do rather than
 * just refusing (R099).
 */
export function refusePlanWithReferralPartner(
  hasReferrer: boolean,
  lang: "en" | "it" = "en",
): string | null {
  if (!hasReferrer) return null
  return lang === "it"
    ? "Questa offerta ha un segnalatore, quindi non può essere venduta con un Pagamento Parziale: " +
      "la provvigione verrebbe accreditata per intero al primo pagamento. Rimuovi il piano, oppure " +
      "togli il segnalatore e registra la provvigione a mano."
    : "This offer has a referrer, so it cannot be sold with a Partial Payment: the commission would " +
      "be credited in full on the first payment. Either drop the plan, or remove the referrer and " +
      "settle their commission by hand."
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
 * The Italian register for the same phrasing — the offer and the contract are bilingual.
 *
 * ⚠️ PLACEHOLDER WORDING, NOT YET APPROVED. Antonio confirmed the INVOICE LABEL — "Pagamento
 * Parziale", used verbatim in `trancheInvoiceDescription` — and said nothing about these
 * schedule lines. Silence is not approval. They are draft copy pending his read of the RENDERED
 * Italian schedule at the click-through gate, where he sees them in context on screen rather
 * than as a string in a message, and approves or replaces them before any client sees one.
 *
 * The BAN, by contrast, is settled: never "rata" or "rateizzazione". That is Antonio's own rule
 * applied to Italian rather than a new decision — "rata" is the word his renewal contracts use,
 * so it carries exactly the collision in Italian that "instalment" carries in English.
 */
const EVENT_WORDING_IT: Record<string, string> = {}

/**
 * What a CLIENT is told about when a part is due.
 *
 * ⛔ The only sanctioned client-facing phrasing, and it never says "instalment". A client reading
 * a formation offer must not see the vocabulary of the annual renewal contract — Antonio's rule,
 * non-negotiable. "Part 2 of 2, due when your bank account is open" answers what they owe and
 * when; "2nd instalment" answers neither and imports the wrong contract.
 */
export function clientFacingPartLabel(
  part: PaymentPlanPart,
  totalParts: number,
  lang: "en" | "it" = "en",
): string {
  if (lang === "it") {
    const posizione = `Parte ${part.seq} di ${totalParts}`
    switch (part.trigger.kind) {
      case "signing":
        return `${posizione}, alla firma`
      case "event":
        return `${posizione}, ${EVENT_WORDING_IT[part.trigger.event ?? ""] ?? "al completamento del passaggio concordato"}`
      case "date":
        return `${posizione}, entro il ${part.trigger.date}`
      case "manual":
      default:
        // Deliberately NOT the staff label — that may name an internal vendor ("Relay") and is
        // nobody's business but ours. The client is told the shape of the agreement they made.
        return `${posizione}, al completamento del passaggio concordato`
    }
  }
  const position = `Part ${part.seq} of ${totalParts}`
  switch (part.trigger.kind) {
    case "signing":
      return `${position}, due on signing`
    case "event":
      return `${position}, due ${EVENT_WORDING[part.trigger.event ?? ""] ?? "when the agreed step is complete"}`
    case "date":
      return `${position}, due ${part.trigger.date}`
    case "manual":
    default:
      return `${position}, due when the agreed step is complete`
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
  lang: "en" | "it" = "en",
): Array<{ seq: number; amount: number; currency: string; label: string }> {
  return plan.map((p) => ({
    seq: p.seq,
    amount: p.amount,
    currency: p.currency,
    label: clientFacingPartLabel(p, plan.length, lang),
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
 * THE APPROVED NAME for a part of a split setup fee, in both languages.
 *
 * Both confirmed by Antonio: "Partial Payment" is his own wording from Domenico's invoice, and
 * "Pagamento Parziale" is the Italian he confirmed verbatim. Neither may be swapped for the
 * renewal contract's vocabulary — see the ban above.
 */
export const PARTIAL_PAYMENT_LABEL: Record<"en" | "it", string> = {
  en: "Partial Payment",
  it: "Pagamento Parziale",
}

/**
 * The description that goes ON the invoice for a part.
 *
 * ⛔ DELIBERATELY ENGLISH-ONLY, and not an oversight. Every invoice description in this system is
 * English regardless of the client's language — an Italian client's other invoices read
 * "LLC Formation Package - Mario". Localising this one line would make a single row of their
 * invoice list disagree with the rest of it. The Italian label exists for the surfaces that DO
 * render Italian: the offer, the contract and the portal schedule.
 */
export function trancheInvoiceDescription(
  part: PaymentPlanPart,
  totalParts: number,
  serviceLabel: string,
): string {
  return `${serviceLabel} — ${PARTIAL_PAYMENT_LABEL.en} (part ${part.seq} of ${totalParts})`
}
