/**
 * TD Communication — landing page content: pure helpers + defaults.
 *
 * CLIENT-SAFE. No DB imports — this is imported by the editor + the public
 * presentational component as well as the server query layer (landing.ts) and
 * the unit tests. The pure merge/validation logic lives here so it can be tested
 * without the DB (mirrors mergeCommSettings in comm-settings.ts).
 */

import type { LandingContent, PortfolioItem } from './types'

/** Hard cap on portfolio items (keeps the JSONB blob + the public page sane). */
export const MAX_PORTFOLIO_ITEMS = 24

/**
 * Default landing content = the current hardcoded "Coming Soon" copy, lifted
 * verbatim from app/portal/td-communication/page.tsx so the DB-driven rollout
 * changes nothing visible. `coming_soon: true` preserves the teaser.
 */
export const DEFAULT_LANDING_CONTENT: LandingContent = {
  hero_headline_en: 'Coming Soon',
  hero_headline_it: 'Presto Disponibile',
  hero_subheadline_en: 'Professional branding for your business',
  hero_subheadline_it: 'Branding professionale per la tua azienda',
  problem_body_en:
    "We're building something special to help your business stand out. Professional logos, landing pages, and brand identity — designed by experts, delivered through your portal.",
  problem_body_it:
    'Stiamo costruendo qualcosa di speciale per far risaltare la tua azienda. Logo professionali, landing page e identità di marca — progettati da esperti e consegnati direttamente nel tuo portale.',
  cta_text_en: 'Start your brand audit',
  cta_text_it: 'Inizia il tuo brand audit',
  portfolio_items: [],
  coming_soon: true,
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

/** Coerce one (possibly malformed) value into a clean PortfolioItem, or null if it has no image. */
export function normalizePortfolioItem(v: unknown): PortfolioItem | null {
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  const image_url = str(o.image_url)
  if (!image_url) return null // an item without an image is meaningless on a portfolio
  return {
    image_url,
    client_name: str(o.client_name),
    description_en: str(o.description_en),
    description_it: str(o.description_it),
  }
}

/** Clean an array of portfolio items: drop image-less entries, cap the count. */
export function normalizePortfolioItems(v: unknown): PortfolioItem[] {
  if (!Array.isArray(v)) return []
  const out: PortfolioItem[] = []
  for (const raw of v) {
    const item = normalizePortfolioItem(raw)
    if (item) out.push(item)
    if (out.length >= MAX_PORTFOLIO_ITEMS) break
  }
  return out
}

/**
 * Layer a (possibly partial / malformed) stored value over the defaults and
 * sanitize every field. Always returns a complete, valid LandingContent — the
 * single gate used by both the API (on write) and the readers (on read).
 */
export function validateLandingContent(stored: Partial<LandingContent> | null | undefined): LandingContent {
  const s = (stored ?? {}) as Record<string, unknown>
  const pick = (key: keyof LandingContent): string => {
    const v = s[key]
    return typeof v === 'string' ? v.trim() : (DEFAULT_LANDING_CONTENT[key] as string)
  }
  return {
    hero_headline_en: pick('hero_headline_en'),
    hero_headline_it: pick('hero_headline_it'),
    hero_subheadline_en: pick('hero_subheadline_en'),
    hero_subheadline_it: pick('hero_subheadline_it'),
    problem_body_en: pick('problem_body_en'),
    problem_body_it: pick('problem_body_it'),
    cta_text_en: pick('cta_text_en'),
    cta_text_it: pick('cta_text_it'),
    portfolio_items: normalizePortfolioItems(s.portfolio_items),
    coming_soon: typeof s.coming_soon === 'boolean' ? s.coming_soon : DEFAULT_LANDING_CONTENT.coming_soon,
  }
}

/** Stable deep-equality of two contents (after normalization) — drives the "unpublished changes" badge. */
export function landingContentEqual(a: LandingContent, b: LandingContent): boolean {
  return JSON.stringify(validateLandingContent(a)) === JSON.stringify(validateLandingContent(b))
}

type LocalizedBase = 'hero_headline' | 'hero_subheadline' | 'problem_body' | 'cta_text'

/** Pick the localized value for a field, falling back to EN when the IT value is blank. */
export function landingText(content: LandingContent, locale: string, base: LocalizedBase): string {
  const en = content[`${base}_en` as keyof LandingContent] as string
  const it = content[`${base}_it` as keyof LandingContent] as string
  if (locale === 'it') return it && it.trim() ? it : en
  return en
}

/** Pick a portfolio item's description for the locale (EN fallback). */
export function portfolioDescription(item: PortfolioItem, locale: string): string {
  if (locale === 'it') return item.description_it && item.description_it.trim() ? item.description_it : item.description_en
  return item.description_en
}
