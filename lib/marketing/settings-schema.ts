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
    ],
  },
  /** Why a lead is marked "not in target" (a reason is required). */
  not_in_target_reasons: {
    schema: optionList,
    fallback: [
      { key: "wrong_profile", label: "Wrong profile" },
      { key: "no_budget", label: "No budget" },
      { key: "italian_resident", label: "Italian-resident trap" },
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
  /** Named bundles of permissions a team owner can hand to a member. Starts empty. */
  permission_bundles: {
    schema: z.record(z.string().trim().min(1).max(60), z.array(z.string().trim().min(1).max(60)).max(60)),
    fallback: {} as Record<string, string[]>,
  },
  /** Which kinds of sale carry commission terms. A catalog value, so a new kind is a settings change. */
  sale_kinds: {
    schema: optionList,
    fallback: [
      { key: "strategic_call", label: "Strategic call" },
      { key: "upsell", label: "Upsell" },
    ],
  },
  /** Currencies a payment link may use. Antonio's ruling: any amount; the currency list is a setting. */
  allowed_currencies: {
    schema: z.array(z.string().regex(/^[A-Z]{3}$/)).min(1).max(20),
    fallback: ["USD", "EUR"],
  },
  /** Above this amount (in the sale's own currency) the link form asks "are you sure?". Not a limit. */
  confirm_above_amount: { schema: z.number().positive().nullable(), fallback: null as number | null },
  /** Whether the team owner may create offers. ON by Antonio's ruling (2026-10-17 late: Rocco has every option on); he can switch it off. */
  owner_may_create_offers: { schema: z.boolean(), fallback: true },
  /** Whether the team owner may export lead lists. ON by Antonio's ruling (2026-10-17 late); every export is logged; he can switch it off. */
  owner_may_export_leads: { schema: z.boolean(), fallback: true },
  /** Whether adding a member needs Antonio's approval first. */
  member_invites_need_approval: { schema: z.boolean(), fallback: false },
  /** The most a team owner can give a member: a ceiling Antonio sets. Empty list = nothing beyond the defaults. */
  member_permission_ceiling: { schema: z.array(z.string().trim().min(1).max(60)).max(60), fallback: [] as string[] },
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
  return p.ok === true ? { value: p.value, usedFallback: false } : { value: defaultForSetting(key), usedFallback: true }
}
