/**
 * Guided tour + setup checklist for the client "Customers & Invoices" hub (dev job 1a23f5f1, plan: sysdoc
 * `client-invoicing-plan`, sections 6 Phase 2 and 6b).
 *
 * TWO LAYERS (Antonio: "the system must be flexible and not hardcoded"):
 *   - LOCKED IN CODE (this file): the registry of screen markers a step may point at, the registry of rules that
 *     decide whether a checklist item is done, the validation, the built-in default tour/checklist, and the
 *     rules for when the tour is offered. Data can only POINT at things code already owns; it can never add a
 *     marker, a rule or a permission.
 *   - EDITABLE DATA: an optional catalog row (catalog `portal_guides`, slugs `tour-invoicing` and
 *     `checklist-invoicing`) can replace the default steps/items. Edited with Claude through the catalog tools,
 *     no editing screen. No row, or a row that does not validate, = the built-in default. A bad row can never
 *     break the page.
 *
 * Pure functions only (unit-tested); loading from the database is in ./guides-server.ts.
 */

import { z } from 'zod'

// ── What data may point at (owned by code) ─────────────────────────────────────

/** Screen spots a tour step may point at. Each is a `data-tour="…"` attribute that code puts on the page. */
export const TOUR_MARKERS = [
  'hub-title', 'nav-invoices',
  'tab-setup', 'tab-customers', 'tab-sales', 'tab-vendors', 'tab-expenses',
  'setup-checklist', 'setup-payment', 'customers-new', 'sales-new', 'sales-list', 'feature-request',
] as const
export type TourMarker = (typeof TOUR_MARKERS)[number]

/** Tabs a step may switch to before looking for its marker. */
export const TOUR_TABS = ['setup', 'customers', 'sales', 'vendors', 'expenses'] as const
export type TourTab = (typeof TOUR_TABS)[number]

/** Rules that decide whether a checklist item is done (computed from live facts in lib/portal/invoice-hub.ts). */
export const CHECKLIST_RULES = ['logo', 'payment', 'customer'] as const
export type ChecklistRule = (typeof CHECKLIST_RULES)[number]

// ── Shapes ─────────────────────────────────────────────────────────────────────

const slug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,40}$/)
const dictKey = z.string().regex(/^[A-Za-z0-9_.-]{1,80}$/)

export const TourStepSchema = z.object({
  id: slug,
  target: z.enum(TOUR_MARKERS),
  tab: z.enum(TOUR_TABS).optional(),
  titleKey: dictKey,
  bodyKey: dictKey,
  placement: z.enum(['top', 'bottom', 'left', 'right', 'center']).optional(),
})
export type TourStep = z.infer<typeof TourStepSchema>

export const TourDefSchema = z.object({
  id: slug,
  /** Bump to offer the tour again to people who finished an older version (never to people who chose "don't show again"). */
  version: z.number().int().min(1).max(1000),
  steps: z.array(TourStepSchema).min(1).max(15),
}).superRefine((def, ctx) => {
  const seen = new Set<string>()
  for (const s of def.steps) {
    if (seen.has(s.id)) ctx.addIssue({ code: 'custom', message: `duplicate step id ${s.id}` })
    seen.add(s.id)
  }
})
export type TourDef = z.infer<typeof TourDefSchema>

export const ChecklistItemSchema = z.object({
  id: slug,
  rule: z.enum(CHECKLIST_RULES),
  required: z.boolean(),
  labelKey: dictKey,
})
export const ChecklistDefSchema = z.object({
  id: slug,
  items: z.array(ChecklistItemSchema).min(1).max(10),
}).superRefine((def, ctx) => {
  const seen = new Set<string>()
  for (const i of def.items) {
    if (seen.has(i.id)) ctx.addIssue({ code: 'custom', message: `duplicate item id ${i.id}` })
    seen.add(i.id)
  }
})
export type ChecklistDef = z.infer<typeof ChecklistDefSchema>
export type ChecklistItemDef = z.infer<typeof ChecklistItemSchema>

// ── Built-in defaults (used when no valid catalog row exists) ──────────────────

export const INVOICING_TOUR_ID = 'invoicing'

export const DEFAULT_INVOICING_TOUR: TourDef = {
  id: INVOICING_TOUR_ID,
  version: 1,
  steps: [
    { id: 'welcome',   target: 'hub-title',     titleKey: 'tour.invoicing.welcome.title',   bodyKey: 'tour.invoicing.welcome.body',   placement: 'bottom' },
    { id: 'setup',     target: 'tab-setup',     titleKey: 'tour.invoicing.setup.title',     bodyKey: 'tour.invoicing.setup.body',     placement: 'bottom' },
    { id: 'payment',   target: 'setup-payment', tab: 'setup', titleKey: 'tour.invoicing.payment.title', bodyKey: 'tour.invoicing.payment.body', placement: 'top' },
    { id: 'customers', target: 'tab-customers', titleKey: 'tour.invoicing.customers.title', bodyKey: 'tour.invoicing.customers.body', placement: 'bottom' },
    { id: 'newcust',   target: 'customers-new', tab: 'customers', titleKey: 'tour.invoicing.newcust.title', bodyKey: 'tour.invoicing.newcust.body', placement: 'left' },
    { id: 'sales',     target: 'tab-sales',     titleKey: 'tour.invoicing.sales.title',     bodyKey: 'tour.invoicing.sales.body',     placement: 'bottom' },
    { id: 'newinv',    target: 'sales-new',     tab: 'sales', titleKey: 'tour.invoicing.newinv.title', bodyKey: 'tour.invoicing.newinv.body', placement: 'left' },
    { id: 'invoicelist', target: 'sales-list', tab: 'sales', titleKey: 'tour.invoicing.invoicelist.title', bodyKey: 'tour.invoicing.invoicelist.body', placement: 'top' },
    { id: 'vendors',   target: 'tab-vendors',   titleKey: 'tour.invoicing.vendors.title',   bodyKey: 'tour.invoicing.vendors.body',   placement: 'bottom' },
    { id: 'expenses',  target: 'tab-expenses',  titleKey: 'tour.invoicing.expenses.title',  bodyKey: 'tour.invoicing.expenses.body',  placement: 'bottom' },
    { id: 'feature',   target: 'feature-request', titleKey: 'tour.invoicing.feature.title', bodyKey: 'tour.invoicing.feature.body',  placement: 'top' },
  ],
}

export const DEFAULT_INVOICING_CHECKLIST: ChecklistDef = {
  id: 'invoicing',
  items: [
    { id: 'logo',     rule: 'logo',     required: false, labelKey: 'invoices.setup.logo' },
    { id: 'payment',  rule: 'payment',  required: true,  labelKey: 'invoices.setup.payment' },
    { id: 'customer', rule: 'customer', required: true,  labelKey: 'invoices.setup.customer' },
  ],
}

// ── Resolving: catalog row if valid, else the default ──────────────────────────

export type PublishIssue = string

/**
 * The check that must pass before an edited tour is used (and that Claude runs before saving a row): every
 * text key must exist in BOTH English and Italian, so a client never sees a raw key.
 */
export function validateTourDef(def: TourDef, hasKey: (key: string, lang: 'en' | 'it') => boolean): PublishIssue[] {
  const issues: PublishIssue[] = []
  for (const s of def.steps) {
    for (const k of [s.titleKey, s.bodyKey]) {
      for (const lang of ['en', 'it'] as const) {
        if (!hasKey(k, lang)) issues.push(`step ${s.id}: text "${k}" is missing in ${lang === 'en' ? 'English' : 'Italian'}`)
      }
    }
  }
  return issues
}

export function validateChecklistDef(def: ChecklistDef, hasKey: (key: string, lang: 'en' | 'it') => boolean): PublishIssue[] {
  const issues: PublishIssue[] = []
  for (const i of def.items) {
    for (const lang of ['en', 'it'] as const) {
      if (!hasKey(i.labelKey, lang)) issues.push(`item ${i.id}: text "${i.labelKey}" is missing in ${lang === 'en' ? 'English' : 'Italian'}`)
    }
  }
  return issues
}

export interface RawGuideRow { metadata?: unknown; status?: string }

function firstValid<T>(rows: RawGuideRow[], parse: (m: unknown) => T | null): T | null {
  for (const r of rows) {
    if (r.status && r.status !== 'active') continue
    const parsed = parse(r.metadata)
    if (parsed) return parsed
  }
  return null
}

/**
 * Per-row safe parse: an invalid row is skipped (never thrown), and the built-in default is used when nothing
 * valid is left. `hasKey` lets the caller reject a row whose wording is missing in English or Italian.
 */
export function resolveTourDef(rows: RawGuideRow[], hasKey?: (key: string, lang: 'en' | 'it') => boolean): TourDef {
  const fromCatalog = firstValid(rows, m => {
    const r = TourDefSchema.safeParse(m)
    if (!r.success) return null
    if (hasKey && validateTourDef(r.data, hasKey).length > 0) return null
    return r.data
  })
  return fromCatalog ?? DEFAULT_INVOICING_TOUR
}

export function resolveChecklistDef(rows: RawGuideRow[], hasKey?: (key: string, lang: 'en' | 'it') => boolean): ChecklistDef {
  const fromCatalog = firstValid(rows, m => {
    const r = ChecklistDefSchema.safeParse(m)
    if (!r.success) return null
    if (hasKey && validateChecklistDef(r.data, hasKey).length > 0) return null
    return r.data
  })
  return fromCatalog ?? DEFAULT_INVOICING_CHECKLIST
}

// ── Remembered state (per login) ───────────────────────────────────────────────

export const TOUR_PREF_KEY_RE = /^tour\.[a-z0-9-]{1,40}$/

export const TourPrefSchema = z.object({
  /** completed = finished or skipped; dismissed = "don't show again". */
  status: z.enum(['completed', 'dismissed']),
  version: z.number().int().min(0).max(1000),
})
export type TourPref = z.infer<typeof TourPrefSchema>

export function parseTourPref(raw: unknown): TourPref | null {
  const r = TourPrefSchema.safeParse(raw)
  return r.success ? r.data : null
}

/**
 * Should the welcome prompt appear on its own? Only for someone who has not been through this version:
 *   - never seen it, or
 *   - finished an OLDER version (a newer version is offered again),
 *   - but NEVER after "don't show again".
 * The "Take the tour" button is always available regardless.
 */
export function shouldOfferTour(pref: TourPref | null, def: Pick<TourDef, 'version'>): boolean {
  if (!pref) return true
  if (pref.status === 'dismissed') return false
  return pref.version < def.version
}

/** Steps whose marker is not on screen are skipped, never stall the tour. */
export function nextStepIndex(from: number, direction: 1 | -1, total: number, isPresent: (index: number) => boolean): number | null {
  let i = from + direction
  while (i >= 0 && i < total) {
    if (isPresent(i)) return i
    i += direction
  }
  return null
}
