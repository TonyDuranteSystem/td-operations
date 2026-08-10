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
  /** For kind='event': a named business event, e.g. "bank_account_opened". */
  event?: string
  /** For kind='date': ISO date. A REMINDER, never a scheduler — see the header. */
  date?: string
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

/** Events a tranche may wait on. A vocabulary, so a typo is a validation error not a silent wait. */
export const TRANCHE_EVENTS = ["bank_account_opened", "ein_received", "company_formed"] as const
export type TrancheEvent = (typeof TRANCHE_EVENTS)[number]

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
      if (!(TRANCHE_EVENTS as readonly string[]).includes(event)) {
        errors.push(
          `${at}: "${event || "(no event)"}" is not a known trigger event. Known: ${TRANCHE_EVENTS.join(", ")}.`,
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

const EVENT_WORDING: Record<string, string> = {
  bank_account_opened: "when your bank account is open",
  ein_received: "when your EIN is issued",
  company_formed: "when your company is formed",
}

/**
 * The Italian register for the same phrasing — the offer and the contract are bilingual.
 *
 * ⚠️ "Pagamento Parziale" is the direct rendering of Antonio's own English wording. He gave the
 * rule in English only, so this translation is stated for his confirmation rather than assumed
 * settled. Whatever he lands on, the constraint is identical in both languages: never the
 * renewal contract's vocabulary ("rata", "rateizzazione") for a split setup fee.
 */
const EVENT_WORDING_IT: Record<string, string> = {
  bank_account_opened: "all'apertura del conto bancario",
  ein_received: "al rilascio dell'EIN",
  company_formed: "alla costituzione della società",
}

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
        return `${posizione}, fatturata separatamente`
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
      return `${position}, invoiced separately`
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
 * The description that goes ON the invoice for a part.
 *
 * Antonio's own wording on Domenico's invoice is "Partial Payment", because it is a partial of the
 * whole setup fee. Kept verbatim as the pattern.
 */
export function trancheInvoiceDescription(
  part: PaymentPlanPart,
  totalParts: number,
  serviceLabel: string,
): string {
  return `${serviceLabel} — Partial Payment (part ${part.seq} of ${totalParts})`
}
