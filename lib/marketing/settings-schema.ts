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
import { isValidZone } from "@/lib/marketing/zones"

const label = z.string().trim().min(1).max(80)
/** A real time zone name ("Atlantic/Canary"). */
const ianaZone = z.string().refine(isValidZone, "Pick a real time zone.")
/** The built-in working hours of a seller: Monday to Friday, 09:00 to 18:00 in his own zone, 30-minute slots, a 15-minute gap, no minimum notice, two weeks ahead. */
export const DEFAULT_CALL_HOURS: { start: number; end: number; slot: number; gap: number; notice: number; ahead: number; days: number[] } = { start: 9, end: 18, slot: 30, gap: 15, notice: 0, ahead: 14, days: [1, 2, 3, 4, 5] }
/** Hours a seller takes calls (see member_call_hours); every field is optional and a missing one takes the built-in value. */
const callHours = z.object({
  start: z.number().int().min(0).max(23).optional(),
  end: z.number().int().min(1).max(24).optional(),
  slot: z.number().int().min(10).max(240).optional(),
  gap: z.number().int().min(0).max(120).optional(),
  notice: z.number().int().min(0).max(10080).optional(),
  ahead: z.number().int().min(1).max(60).optional(),
  /** the weekdays he takes calls: 0 = Sunday … 6 = Saturday */
  days: z.array(z.number().int().min(0).max(6)).min(1).max(7).optional(),
}).refine(h => (h.start ?? DEFAULT_CALL_HOURS.start) < (h.end ?? DEFAULT_CALL_HOURS.end), "The working day must end after it starts.")
const calendlyLink = z.object({
  id: z.string().regex(/^[a-z0-9-]{1,40}$/),
  name: z.string().trim().min(1).max(40),
  url: z.string().trim().max(500).refine(u => /^https:\/\/[^\s/]+\.[^\s/]+\S*$/i.test(u), "Use a link that starts with https://"),
})
export type CalendlyLink = z.infer<typeof calendlyLink>
export type CallHoursInput = z.infer<typeof callHours>
const optionList = z
  .array(z.object({ key: z.string().trim().min(1).max(40).regex(/^[a-z0-9_]+$/), label }))
  .min(1)
  .max(40)
  .refine(l => new Set(l.map(o => o.key)).size === l.length, "Each key must be unique")

/** Where each result the seller presses puts a lead (stage keys of pipeline_stages). The last five were added after the first three; a team's stored value may not have them. */
export interface SellerResultStages { not_ready: string; closed: string; not_closed: string; contacted?: string; booking_link?: string; upsell?: string; waiting?: string; archived?: string }

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
      // Rocco's path after the setter hands a lead over (the call of 27 Oct 2026): Contacted, Link sent, Paid, Booking link sent, then Upsell / Waiting, and Archived closes it.
      // The order matters: a lead at one of these is "past" Booked, so booking a call never pulls it back.
      { key: "seller_contacted", label: "Seller contacted" },
      { key: "not_ready", label: "Not ready now" },
      { key: "closed", label: "Link sent" },
      { key: "not_closed", label: "Not closed" },
      { key: "paid_call", label: "Paid call" },
      { key: "booking_link", label: "Booking link sent" },
      { key: "upsell", label: "Upsell" },
      { key: "waiting", label: "Waiting" },
      { key: "upsell_won", label: "Upsell won" },
      { key: "archived", label: "Archived" },
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
  /** Which stage each result the SELLER presses after the call moves a lead to (Rocco: "Not ready now" with a come-back day, "Closed", "Not closed"). The keys must exist in pipeline_stages. */
  seller_result_stages: {
    schema: z.object({
      not_ready: z.string().trim().min(1).max(40),
      closed: z.string().trim().min(1).max(40),
      not_closed: z.string().trim().min(1).max(40),
      // Rocco's later steps; a team that stored the three above before these existed gets the built-in keys
      contacted: z.string().trim().min(1).max(40).optional(),
      booking_link: z.string().trim().min(1).max(40).optional(),
      upsell: z.string().trim().min(1).max(40).optional(),
      waiting: z.string().trim().min(1).max(40).optional(),
      archived: z.string().trim().min(1).max(40).optional(),
    }),
    fallback: { not_ready: "not_ready", closed: "closed", not_closed: "not_closed", contacted: "seller_contacted", booking_link: "booking_link", upsell: "upsell", waiting: "waiting", archived: "archived" } as SellerResultStages,
  },
  /** Why a lead is marked "not in target" (a reason is required). */
  not_in_target_reasons: {
    schema: optionList,
    fallback: [
      { key: "wrong_profile", label: "Wrong profile" },
      { key: "lives_in_italy_no_business", label: "Lives in Italy, no business" },
      { key: "not_interested", label: "Not interested" },
      { key: "fake", label: "Fake / no target" },
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
  /**
   * The team's own message templates, by key (round 2 step 4; edited by the team owner only). A built-in key (first_contact, …) keeps its built-in wording for any field left out; a key that is
   * not built in is a template the owner created and needs a `label` and a text. Placeholders: {name} {setter} {when}. Replaces nothing: `message_templates` above still applies to a
   * built-in key that has no entry here.
   */
  team_templates: {
    schema: z.record(z.string().regex(/^[a-z0-9_]{1,60}$/), z.object({ label: z.string().trim().max(80).optional(), it: z.string().trim().max(4000).optional(), en: z.string().trim().max(4000).optional() })).refine(o => Object.keys(o).length <= 80, "Too many templates."),
    fallback: {} as Record<string, { label?: string; it?: string; en?: string }>,
  },
  /** Named bundles of permissions a team owner can hand to a member. Starting values from plan v1.4 (A.3); all editable. */
  permission_bundles: {
    schema: z.record(z.string().trim().min(1).max(60), z.array(z.string().trim().min(1).max(60)).max(60)),
    fallback: {
      // calls and filters leads: no payment links, no Money, no export, no team management
      // no inbox: the setter has no email address of her own (27 Oct 2026, Rocco and Antonio)
      // no Documents: Antonio never decided the setter should read the company presentation and the services description (29 Oct 2026); he can add it in Settings
      setter: ["leads.read", "leads.call", "leads.mark", "leads.worklist", "team.notes", "whatsapp", "chat"],
      // ads, video, posts: chat, content, reports; reads leads
      content: ["chat", "inbox", "content.manage", "reports.read", "leads.read", "documents", "documents.manage"],
      // contacts the leads the setters pass: works them, sends the free-call link, no money screens
      seller: ["leads.read", "leads.pick", "leads.call", "leads.mark", "team.notes", "whatsapp", "chat", "inbox", "calls.host", "documents", "documents.manage"],
      // sees everything, changes nothing: for analysing the ads and the team
      analyst: ["leads.read", "team.activity", "team.notes", "reports.read", "documents"],
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
  /** The mailboxes the team's Inbox may open (dev job 9aec66fa). Only Antonio changes this list (CRM > Marketing > Settings): the system's Gmail key can open any company mailbox, so the list IS the wall. Fails closed (empty) when broken. */
  inbox_mailboxes: {
    schema: z.array(z.object({
      address: z.string().trim().toLowerCase().regex(/^[a-z0-9._+-]{1,64}@tonydurante\.us$/),
      people: z.array(z.string().uuid()).max(60),
      signature_name: z.string().max(80).default(""),
      signature_title: z.string().max(80).default(""),
      signature_phone: z.string().max(80).default(""),
    })).max(20).refine(l => new Set(l.map(m => m.address)).size === l.length, "Each address once"),
    fallback: [] as Array<{ address: string; people: string[]; signature_name: string; signature_title: string; signature_phone: string }>,
  },
  /** Which team the leads arriving from Meta belong to. Empty text = no team chosen: the only ACTIVE team if there is exactly one, else nobody's yet (Antonio sees them and assigns). */
  lead_intake_team_id: { schema: z.union([z.string().uuid(), z.literal("")]), fallback: "" as string },
  /**
   * Time zones and calendars (Addendum K, 30 Oct 2026). The business owner's clock: the zone Antonio lives in and the name shown on his clock ("Antonio"). It is the clock shown to the seller
   * and the owner next to a lead's, and NEVER to a setter. Until it is set it reads Rome, as every screen did before.
   */
  owner_clock: { schema: z.object({ zone: ianaZone, label: z.string().trim().min(1).max(40), email: z.string().trim().toLowerCase().max(120).regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/).optional() }), fallback: { zone: "Europe/Rome", label: "Owner" } as { zone: string; label: string; email?: string } },
  /** Each team member's own time zone, by user id; a member without an entry reads Rome time. Set on the Team screen. */
  member_time_zones: { schema: z.record(z.string().uuid(), ianaZone).refine(o => Object.keys(o).length <= 60, "Too many people."), fallback: {} as Record<string, string> },
  /**
   * The people who TAKE CALLS with leads (the seller), and their hours: an entry here is what makes a member bookable. Working hours in the member's own zone, the length of a slot, the gap kept around
   * anything busy, the shortest notice for a booking (minutes) and how far ahead (days) a slot is offered. A field left out takes the built-in value (DEFAULT_CALL_HOURS).
   */
  member_call_hours: { schema: z.record(z.string().uuid(), callHours).refine(o => Object.keys(o).length <= 60, "Too many people."), fallback: {} as Record<string, CallHoursInput> },
  /** A member's own booking links (Calendly), by user id: any number, each with a name ("Solo call", "With Antonio"). The booking box on a paid lead offers them. */
  member_calendly_links: { schema: z.record(z.string().uuid(), z.array(calendlyLink).max(12)).refine(o => Object.keys(o).length <= 60, "Too many people."), fallback: {} as Record<string, CalendlyLink[]> },
  /** The personal Google calendars (addresses) whose BUSY time a member's slots must avoid, by user id. They are shared with his work mailbox as "free/busy only"; the system asks Google only when he is busy. */
  member_personal_calendars: { schema: z.record(z.string().uuid(), z.array(z.string().trim().toLowerCase().max(120).regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/)).max(6)).refine(o => Object.keys(o).length <= 60, "Too many people."), fallback: {} as Record<string, string[]> },
  /** Switch: show the seller's Busy time on the Calendar and offer the setter only the seller's free slots. OFF until the go-live check (Addendum K, K.7 B6). */
  calendar_busy_enabled: { schema: z.boolean(), fallback: false },
  /** Switch: a call booked, moved or cancelled in Marketing is also written into the seller's work Google calendar, so Calendly cannot offer the same hour. OFF until the go-live check. */
  calendar_write_through_enabled: { schema: z.boolean(), fallback: false },
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
const FAIL_CLOSED: Partial<Record<MarketingSettingKey, unknown>> = { permission_bundles: {}, inbox_mailboxes: [] }
export function failClosedValue(key: MarketingSettingKey): unknown {
  return Object.prototype.hasOwnProperty.call(FAIL_CLOSED, key) ? FAIL_CLOSED[key] : undefined
}
