/**
 * Booking page — the KINDS of link (Lead / Client / Partner / Private / anything added later) and their flat rule.
 *
 * A kind is a row of the catalog `booking_kinds`; its rule is the row's metadata. The rule is deliberately flat — two answers and two switches:
 *   existing_person  what a booking by someone who is ALREADY A CONTACT does:  attach (saved under the contact, no lead) | lead (today's behaviour) | none (nothing saved)
 *   new_person       what a booking by someone NOT YET IN THE SYSTEM does:      lead | none
 *   mark_lead        the lead this booking creates gets "Booking kind: <label>" as the first line of its notes
 *   sales_template   a free call for a new person uses the Calendly template that asks the sales questions
 * A made link pins a SNAPSHOT of the rule (booking_links.rule_snapshot), so renaming, retiring or editing a kind never changes a link already sent.
 * Pure: no database, no clock.
 */

export const EXISTING_PERSON_RULES = ["attach", "lead", "none"] as const
export const NEW_PERSON_RULES = ["lead", "none"] as const
export type ExistingPersonRule = (typeof EXISTING_PERSON_RULES)[number]
export type NewPersonRule = (typeof NEW_PERSON_RULES)[number]

export interface KindRule {
  existing_person: ExistingPersonRule
  new_person: NewPersonRule
  mark_lead: boolean
  sales_template: boolean
}

export type KindParse = { ok: true; rule: KindRule; sortOrder: number } | { ok: false; reason: string }

const isRec = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v)

/** Reads a catalog row's metadata. A kind added through a generic tool (no metadata) comes back `ok: false` = "needs setup": the maker refuses it. */
export function parseKindRule(metadata: unknown): KindParse {
  if (!isRec(metadata)) return { ok: false, reason: "This kind has no rule yet (needs setup)." }
  const existing = metadata.existing_person
  const fresh = metadata.new_person
  if (!(EXISTING_PERSON_RULES as readonly unknown[]).includes(existing)) return { ok: false, reason: "This kind does not say what happens when the person is already a contact (needs setup)." }
  if (!(NEW_PERSON_RULES as readonly unknown[]).includes(fresh)) return { ok: false, reason: "This kind does not say what happens when the person is new (needs setup)." }
  if (typeof metadata.mark_lead !== "boolean" || typeof metadata.sales_template !== "boolean") return { ok: false, reason: "This kind is missing a yes/no setting (needs setup)." }
  const sort = typeof metadata.sort_order === "number" && Number.isFinite(metadata.sort_order) ? metadata.sort_order : 1000
  return {
    ok: true,
    rule: { existing_person: existing as ExistingPersonRule, new_person: fresh as NewPersonRule, mark_lead: metadata.mark_lead, sales_template: metadata.sales_template },
    sortOrder: sort,
  }
}

/** What is stored on the link row. `v` lets a later change of the rule's shape be told apart. */
export interface RuleSnapshot {
  v: 1
  kind_slug: string
  kind_label: string
  rule: KindRule
}

export const RULE_SNAPSHOT_VERSION = 1

export function buildRuleSnapshot(kind: { slug: string; label: string }, rule: KindRule): RuleSnapshot {
  return { v: 1, kind_slug: kind.slug, kind_label: kind.label, rule: { ...rule } }
}

/** The webhook NEVER reads the catalog: it reads the snapshot on the link row, and a malformed one is `null` (the webhook then keeps today's behaviour and raises a card). */
export function parseRuleSnapshot(raw: unknown): RuleSnapshot | null {
  if (!isRec(raw) || raw.v !== 1) return null
  if (typeof raw.kind_slug !== "string" || typeof raw.kind_label !== "string") return null
  const parsed = parseKindRule(raw.rule)
  if (!parsed.ok) return null
  return { v: 1, kind_slug: raw.kind_slug, kind_label: raw.kind_label, rule: parsed.rule }
}

/** Kind names are compared ignoring capitals, accents and extra spaces — including retired kinds — so "Cliënt" cannot be added next to "Client". */
export function kindNameKey(name: string): string {
  return name.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, " ").trim().toLowerCase()
}

/** True when a new kind name collides with an existing one (retired ones included). */
export function kindNameTaken(name: string, existingNames: readonly string[]): boolean {
  const key = kindNameKey(name)
  if (!key) return true
  return existingNames.some((n) => kindNameKey(n) === key)
}
