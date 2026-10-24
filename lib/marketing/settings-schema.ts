/**
 * TD Marketing — the settings Antonio can change (P0, dev job 9aec66fa).
 *
 * Pure and client-safe (no database here). Every rule lives as a VALUE under a key; the defaults below are only what a
 * brand-new install starts with, and a stored value always wins. Nothing elsewhere in the marketing code may hardcode a
 * stage name, a reason, a percentage or a switch: it reads them through `lib/marketing/settings.ts`.
 *
 * Values here were taken from the plan and Antonio's rulings of 2026-10-17: no price rules, no VAT, 80/20 is a setting,
 * offers and lead export are ON for the team owner (Rocco has every option); member approvals start OFF.
 */
import { z } from "zod"

const label = z.string().trim().min(1).max(80)
const optionList = z
  .array(z.object({ key: z.string().trim().min(1).max(40).regex(/^[a-z0-9_]+$/), label }))
  .min(1)
  .max(40)
  .refine(l => new Set(l.map(o => o.key)).size === l.length, "Each key must be unique")

export const MARKETING_SETTING_DEFS = {
  /** The steps a lead moves through. Order matters; the first one is where a new lead lands. */
  pipeline_stages: {
    schema: optionList,
    fallback: [
      { key: "new", label: "New" },
      { key: "contacted", label: "Contacted" },
      { key: "qualified", label: "Qualified" },
      { key: "booked", label: "Booked" },
      { key: "showed", label: "Showed" },
      { key: "paid_call", label: "Paid call" },
      { key: "upsell_won", label: "Upsell won" },
      { key: "not_in_target", label: "Not in target" },
    ],
  },
  /** Which stage each setter outcome moves a lead to. The keys must exist in pipeline_stages (checked when the outcome is saved). */
  setter_outcome_stages: {
    schema: z.object({
      good: z.string().trim().min(1).max(40),
      not_in_target: z.string().trim().min(1).max(40),
      call_back: z.string().trim().min(1).max(40),
    }),
    fallback: { good: "qualified", not_in_target: "not_in_target", call_back: "contacted" } as { good: string; not_in_target: string; call_back: string },
  },
  /** Why a lead is marked "not in target" (a reason is required). */
  not_in_target_reasons: {
    schema: optionList,
    fallback: [
      { key: "wrong_profile", label: "Wrong profile" },
      { key: "lives_in_italy_no_business", label: "Lives in Italy, no business" },
      { key: "not_interested", label: "Not interested" },
      { key: "other", label: "Other" },
    ],
  },
  /** The qualification checklist shown on a lead card. Starts empty: filled in with Antonio. */
  qualification_checklist: { schema: z.array(label).max(40), fallback: [] as string[] },
  /** Message templates by key. Starts empty: filled in with Antonio. */
  message_templates: {
    schema: z.record(z.string().trim().min(1).max(60), z.string().max(4000)),
    fallback: {} as Record<string, string>,
  },
  /** Named bundles of permissions a team owner can hand to a member. Starting values from plan v1.4 (A.3); all editable. */
  permission_bundles: {
    schema: z.record(z.string().trim().min(1).max(60), z.array(z.string().trim().min(1).max(60)).max(60)),
    fallback: {
      // calls and filters leads: no payment links, no Money, no export, no team management
      setter: ["leads.read", "leads.call", "leads.mark", "leads.worklist", "team.notes", "whatsapp", "chat", "inbox"],
      // ads, video, posts: chat, content, reports; reads leads
      content: ["chat", "inbox", "content.manage", "reports.read", "leads.read"],
      // contacts the leads the setters pass: works them, sends the free-call link, no money screens
      seller: ["leads.read", "leads.pick", "leads.call", "leads.mark", "team.notes", "whatsapp", "chat", "inbox", "calls.host"],
      // sees everything, changes nothing: for analysing the ads and the team
      analyst: ["leads.read", "team.activity", "team.notes", "reports.read"],
    } as Record<string, string[]>,
  },
  /** Which kinds of sale carry commission terms. A catalog value, so a new kind is a settings change. */
  sale_kinds: {
    schema: optionList,
    fallback: [
      { key: "strategic_call", label: "Strategic call" },
      { key: "upsell", label: "Upsell" },
    ],
  },
  /** The stage a lead moves to when a sale of each kind is paid. Keys are sale kinds; each value must be a pipeline stage (checked when used: a missing stage never blocks recording the payment). */
  sale_kind_stages: {
    schema: z.record(z.string().trim().min(1).max(40), z.string().trim().min(1).max(40)),
    fallback: { strategic_call: "paid_call", upsell: "upsell_won" } as Record<string, string>,
  },
  /** Currencies a payment link may use. Antonio's ruling: any amount; the currency list is a setting. */
  allowed_currencies: {
    schema: z.array(z.string().regex(/^[A-Z]{3}$/)).min(1).max(20),
    fallback: ["USD", "EUR"],
  },
  /** Above this amount (in the sale's own currency) the link form asks "are you sure?". Not a limit. */
  confirm_above_amount: { schema: z.number().positive().nullable(), fallback: null as number | null },
  /** The currency the seller's company is paid (and invoices) in when it differs from the sale's. Same number, no exchange rate. Empty = the sale's own currency. */
  seller_payout_currency: { schema: z.union([z.string().regex(/^[A-Z]{3}$/), z.literal("")]), fallback: "" as string },
  /** Whether the team owner may create offers. ON by Antonio's ruling (2026-10-17 late: Rocco has every option on); he can switch it off. */
  owner_may_create_offers: { schema: z.boolean(), fallback: true },
  /** Whether the team owner may export lead lists. ON by Antonio's ruling (2026-10-17 late); every export is logged; he can switch it off. */
  owner_may_export_leads: { schema: z.boolean(), fallback: true },
  /** Whether adding a member needs Antonio's approval first. */
  member_invites_need_approval: { schema: z.boolean(), fallback: false },
  /** Which team the leads arriving from Meta belong to. Empty text = no team chosen: the only ACTIVE team if there is exactly one, else nobody's yet (Antonio sees them and assigns). */
  lead_intake_team_id: { schema: z.union([z.string().uuid(), z.literal("")]), fallback: "" as string },
} as const

export type MarketingSettingKey = keyof typeof MARKETING_SETTING_DEFS

export const MARKETING_SETTING_KEYS = Object.keys(MARKETING_SETTING_DEFS) as MarketingSettingKey[]

export function isMarketingSettingKey(k: string): k is MarketingSettingKey {
  return Object.prototype.hasOwnProperty.call(MARKETING_SETTING_DEFS, k)
}

/** A setting's built-in starting value (a copy, so callers can never change the shared default). */
export function defaultForSetting<K extends MarketingSettingKey>(key: K): (typeof MARKETING_SETTING_DEFS)[K]["fallback"] {
  return structuredClone(MARKETING_SETTING_DEFS[key].fallback)
}

export type ParsedSetting = { ok: true; value: unknown } | { ok: false; error: string }

/** Validate a value for a key. Never throws; an unknown key or a bad shape comes back as a plain message. */
export function parseSettingValue(key: string, raw: unknown): ParsedSetting {
  if (!isMarketingSettingKey(key)) return { ok: false, error: `Unknown setting "${key}".` }
  const r = (MARKETING_SETTING_DEFS[key].schema as z.ZodTypeAny).safeParse(raw)
  if (r.success === false) {
    const first = r.error.issues[0]
    const where = first?.path?.length ? ` (${first.path.join(".")})` : ""
    return { ok: false, error: `${key}: ${first?.message ?? "invalid value"}${where}` }
  }
  return { ok: true, value: r.data }
}

/**
 * The value to use: the stored one if it is valid, else the built-in default. A stored value that no longer fits the
 * rules (an old shape) never breaks the app; it falls back and `usedFallback` says so.
 */
export function resolveSetting(key: MarketingSettingKey, stored: unknown): { value: unknown; usedFallback: boolean } {
  if (stored === undefined) return { value: defaultForSetting(key), usedFallback: true }
  const p = parseSettingValue(key, stored)
  if (p.ok === true) return { value: p.value, usedFallback: false }
  // A stored value that EXISTS but is broken. For a setting that grants access the safe answer is "nothing", not the built-in
  // default (which may be wider than what Antonio narrowed it to): the door stays shut until the setting is repaired.
  const closed = failClosedValue(key)
  return { value: closed !== undefined ? closed : defaultForSetting(key), usedFallback: true }
}

/** Settings that GRANT access. When their stored value is broken, or cannot be read at all, the result is this (no access), never the default. */
const FAIL_CLOSED: Partial<Record<MarketingSettingKey, unknown>> = { permission_bundles: {} }
export function failClosedValue(key: MarketingSettingKey): unknown {
  return Object.prototype.hasOwnProperty.call(FAIL_CLOSED, key) ? FAIL_CLOSED[key] : undefined
}
