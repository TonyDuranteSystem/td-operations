/**
 * TD Communication — Portfolio Manager pure logic (no DB / no I/O / no crypto).
 *
 * CLIENT-SAFE (mirrors landing-content.ts): imported by the public page, the
 * curator UI, and the unit tests. The DB layer lives in ./portfolio-queries.ts;
 * the consent wording + version hashing (node:crypto) lives in the server module
 * ./showcase-consent.ts so this file stays bundleable in the browser.
 */

import type {
  PortfolioConsentSource,
  PortfolioEntry,
  PortfolioEntryInput,
  PortfolioEntryWithConsent,
  PublicPortfolioEntry,
  ShowcaseConsent,
} from './types'

/** Caps that keep the table + public page sane. */
export const MAX_TAGS = 12
export const MAX_TAG_LENGTH = 40
export const MAX_TITLE_LENGTH = 120
export const MAX_DESCRIPTION_LENGTH = 2000

const CONSENT_SOURCES: readonly PortfolioConsentSource[] = ['client_optin', 'written_on_file', 'none']

/** Type guard for the consent_source enum (default-deny → 'none'). */
export function isValidConsentSource(v: unknown): v is PortfolioConsentSource {
  return typeof v === 'string' && (CONSENT_SOURCES as readonly string[]).includes(v)
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

/**
 * Clean a tags value into a deduped, lower-cased, trimmed, capped array.
 * Tags are language-neutral filter keys.
 */
export function normalizeTags(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of v) {
    if (typeof raw !== 'string') continue
    const t = raw.trim().toLowerCase().slice(0, MAX_TAG_LENGTH)
    if (!t || seen.has(t)) continue
    seen.add(t)
    out.push(t)
    if (out.length >= MAX_TAGS) break
  }
  return out
}

/** The result of validating a curator write. `error` is null when the entry is usable. */
export interface PortfolioValidation {
  value: {
    enrollment_id: string | null
    title_en: string
    title_it: string
    client_name: string
    description_en: string
    description_it: string
    before_image_url: string | null
    after_image_url: string
    category: string | null
    tags: string[]
    featured: boolean
    consent_source: PortfolioConsentSource
    consent_id: string | null
  } | null
  error: string | null
}

/**
 * Validate + sanitize a curator's create/update payload. The one hard rule: an
 * "after" image is required (it's the showcased result). Everything else is
 * cleaned to a safe shape. Text is trimmed + length-capped; tags normalized.
 */
export function validatePortfolioInput(input: PortfolioEntryInput | null | undefined): PortfolioValidation {
  const i = input ?? {}
  const after = str(i.after_image_url)
  if (!after) {
    return { value: null, error: 'A finished ("after") image is required.' }
  }
  const before = str(i.before_image_url)
  const category = str(i.category)
  const consent_source = isValidConsentSource(i.consent_source) ? i.consent_source : 'none'
  return {
    value: {
      enrollment_id: typeof i.enrollment_id === 'string' && i.enrollment_id ? i.enrollment_id : null,
      title_en: str(i.title_en).slice(0, MAX_TITLE_LENGTH),
      title_it: str(i.title_it).slice(0, MAX_TITLE_LENGTH),
      client_name: str(i.client_name).slice(0, MAX_TITLE_LENGTH),
      description_en: str(i.description_en).slice(0, MAX_DESCRIPTION_LENGTH),
      description_it: str(i.description_it).slice(0, MAX_DESCRIPTION_LENGTH),
      before_image_url: before || null,
      after_image_url: after,
      category: category || null,
      tags: normalizeTags(i.tags),
      featured: i.featured === true,
      consent_source,
      consent_id: typeof i.consent_id === 'string' && i.consent_id ? i.consent_id : null,
    },
    error: null,
  }
}

/** True when a consent row is currently in force (granted and not revoked). */
export function isCurrentConsent(consent: Pick<ShowcaseConsent, 'revoked_at'> | null | undefined): boolean {
  return !!consent && !consent.revoked_at
}

/**
 * Derive the consent badge state for a curator-view entry, given its linked
 * consent row (or null). Soft model: this is informational — it never blocks
 * publishing — but a `withdrawn` state means a client_optin was revoked.
 */
export function deriveConsentState(
  entry: Pick<PortfolioEntry, 'consent_source'>,
  consent: Pick<ShowcaseConsent, 'revoked_at'> | null | undefined,
): PortfolioEntryWithConsent['consent_state'] {
  if (entry.consent_source === 'written_on_file') return 'written_on_file'
  if (entry.consent_source === 'client_optin') {
    return isCurrentConsent(consent) ? 'opted_in' : 'withdrawn'
  }
  return 'none'
}

/** Whether an entry is tied to a real project or was entered manually. */
export function entrySource(entry: Pick<PortfolioEntry, 'enrollment_id'>): 'project' | 'manual' {
  return entry.enrollment_id ? 'project' : 'manual'
}

/**
 * The distinct, sorted list of categories present on the given entries — the
 * public/curator category filter is DERIVED from this, never a hardcoded list.
 */
export function deriveCategories(entries: Array<Pick<PortfolioEntry, 'category'>>): string[] {
  const seen = new Set<string>()
  for (const e of entries) {
    const c = str(e.category)
    if (c) seen.add(c)
  }
  return Array.from(seen).sort((a, b) => a.localeCompare(b))
}

type LocalizedBase = 'title' | 'description'

/** Localized title/description with EN fallback when the IT value is blank. */
export function portfolioText(
  entry: Pick<PublicPortfolioEntry, 'title_en' | 'title_it' | 'description_en' | 'description_it'>,
  locale: string,
  base: LocalizedBase,
): string {
  const en = entry[`${base}_en` as const]
  const it = entry[`${base}_it` as const]
  if (locale === 'it') return it && it.trim() ? it : en
  return en
}

/** Strip a full entry down to the public-safe subset served to the unauthenticated page. */
export function toPublicEntry(entry: PortfolioEntry): PublicPortfolioEntry {
  return {
    id: entry.id,
    title_en: entry.title_en,
    title_it: entry.title_it,
    client_name: entry.client_name,
    description_en: entry.description_en,
    description_it: entry.description_it,
    before_image_url: entry.before_image_url,
    after_image_url: entry.after_image_url,
    category: entry.category,
    tags: entry.tags,
    featured: entry.featured,
  }
}

/**
 * Filter public entries by an optional category and/or tag (both case-insensitive).
 * Empty/undefined filters pass everything. Pure — used by the public page.
 */
export function filterPublicEntries(
  entries: PublicPortfolioEntry[],
  opts: { category?: string | null; tag?: string | null } = {},
): PublicPortfolioEntry[] {
  const cat = str(opts.category).toLowerCase()
  const tag = str(opts.tag).toLowerCase()
  return entries.filter((e) => {
    if (cat && str(e.category).toLowerCase() !== cat) return false
    if (tag && !e.tags.some((t) => t.toLowerCase() === tag)) return false
    return true
  })
}
