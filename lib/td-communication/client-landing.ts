/**
 * TD Communication — Client Landing Page (Phase 16) pure logic.
 *
 * CLIENT-SAFE (mirrors landing-content.ts / portfolio.ts): no DB, no I/O, no
 * crypto. Imported by the editor, the public renderer, the server query layer
 * (client-landing-queries.ts) and the unit tests. All validation / sanitization
 * lives here so it can be tested without the DB.
 *
 * SECURITY: the /site/[slug] page is PUBLIC and unauthenticated. Every field is
 * rendered as TEXT by React (never dangerouslySetInnerHTML). URL fields are
 * additionally sanitized here: link hrefs to http(s)/mailto/tel only (javascript:,
 * data:, protocol-relative all rejected); image URLs pinned to OUR public
 * assets-bucket origin (an off-origin image on a page we host is a spoof/tracking
 * vector). The same validator runs on write AND on the public read (defense in
 * depth — a pre-fix row or a direct DB touch can never render unsanitized).
 */

import { normalizeHex, bestTextColor } from './color-tools'
import type {
  BrandProfile,
} from './brand-profile'
import type {
  ClandLocale,
  ClandFontKey,
  ClandSectionType,
  ClandTheme,
  ClandSection,
  ClandServiceItem,
  ClandGalleryImage,
  ClandContactLink,
  ClientLandingContent,
  ClientLandingSite,
  PublicClientLanding,
} from './types'

/* --------------------------------- caps ---------------------------------- */

export const MAX_HEADING = 160
export const MAX_BODY = 4000
export const MAX_SHORT = 200 // labels, cta, captions, email, phone
export const MAX_SERVICE_ITEMS = 12
export const MAX_GALLERY_IMAGES = 12
export const MAX_CONTACT_LINKS = 8
export const MAX_SECTIONS = 20

/* ------------------------------- primitives ------------------------------ */

function str(v: unknown, cap = MAX_SHORT): string {
  return (typeof v === 'string' ? v : '').trim().slice(0, cap)
}

/** Fonts: system stacks only (no webfont files → no CDN, no CSP change). */
export const FONT_STACKS: Record<ClandFontKey, string> = {
  modern_sans:
    'system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
  elegant_serif: 'Georgia, Cambria, "Times New Roman", Times, serif',
  geometric: '"Avenir Next", "Century Gothic", "Futura", system-ui, sans-serif',
}

export const FONT_KEYS: readonly ClandFontKey[] = ['modern_sans', 'elegant_serif', 'geometric']
export const SECTION_TYPES_LIST: readonly ClandSectionType[] = [
  'hero',
  'about',
  'services',
  'gallery',
  'contact',
  'custom_text',
]

const LOCALES: readonly ClandLocale[] = ['en', 'it']

export function isClandLocale(v: unknown): v is ClandLocale {
  return typeof v === 'string' && (LOCALES as readonly string[]).includes(v)
}
export function isClandFontKey(v: unknown): v is ClandFontKey {
  return typeof v === 'string' && (FONT_KEYS as readonly string[]).includes(v)
}
export function isClandSectionType(v: unknown): v is ClandSectionType {
  return typeof v === 'string' && (SECTION_TYPES_LIST as readonly string[]).includes(v)
}

/* ------------------------------ URL sanitizers --------------------------- */

/**
 * The public assets-bucket URL prefix. Copied logos/gallery images live here
 * (copyDeliverableImageToPublic → getPublicUrl returns exactly this shape). Any
 * image URL not under this prefix is dropped. Reads NEXT_PUBLIC_SUPABASE_URL
 * (inlined client-side by Next; present server-side). Overridable in tests.
 */
export function publicAssetsPrefix(): string {
  const base = (process.env.NEXT_PUBLIC_SUPABASE_URL || '').replace(/\/+$/, '')
  return base ? `${base}/storage/v1/object/public/assets/` : ''
}

/** Strip ASCII control chars + whitespace obfuscation before any scheme match. */
function stripControl(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u0020\u007f]/g, '')
}

/**
 * Sanitize a link href. Allows ONLY absolute http(s), mailto:, tel:. Rejects
 * javascript:, data:, protocol-relative //host, and anything relative/ambiguous
 * (→ '' so the renderer omits the link). Obfuscation (java\tscript:) is stripped
 * of control/space chars before the scheme test.
 */
export function sanitizeLinkHref(v: unknown): string {
  const raw = typeof v === 'string' ? v.trim() : ''
  if (!raw) return ''
  const stripped = stripControl(raw)
  if (!stripped) return ''
  if (stripped.startsWith('//')) return '' // protocol-relative
  const lower = stripped.toLowerCase()
  if (lower.startsWith('mailto:') || lower.startsWith('tel:')) return raw.trim().slice(0, 500)
  if (lower.startsWith('http://') || lower.startsWith('https://')) return raw.trim().slice(0, 500)
  return '' // no scheme, or a disallowed scheme (javascript:, data:, etc.)
}

/**
 * Sanitize an image URL: must be an absolute URL under OUR public assets-bucket
 * origin. Anything else (off-origin host, data:, relative) → '' (dropped).
 */
export function sanitizeImageUrl(v: unknown, prefix: string = publicAssetsPrefix()): string {
  const raw = typeof v === 'string' ? v.trim() : ''
  if (!raw || !prefix) return ''
  const stripped = stripControl(raw)
  return stripped.startsWith(prefix) ? raw.trim().slice(0, 1000) : ''
}

/* --------------------------------- theme --------------------------------- */

/** A neutral default theme (used when no brand profile / bad hexes). */
export const DEFAULT_THEME: ClandTheme = {
  primary: '#1f2937',
  secondary: '#4b5563',
  accent: '#2563eb',
  text: '#111827',
  font_key: 'modern_sans',
  logo_url: null,
}

function pickHex(v: unknown, fallback: string): string {
  const n = normalizeHex(typeof v === 'string' ? v : '')
  return n || fallback
}

/** Validate/normalize a theme object to a safe, complete ClandTheme. */
export function sanitizeTheme(v: unknown, prefix?: string): ClandTheme {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>
  return {
    primary: pickHex(o.primary, DEFAULT_THEME.primary),
    secondary: pickHex(o.secondary, DEFAULT_THEME.secondary),
    accent: pickHex(o.accent, DEFAULT_THEME.accent),
    text: pickHex(o.text, DEFAULT_THEME.text),
    font_key: isClandFontKey(o.font_key) ? o.font_key : DEFAULT_THEME.font_key,
    logo_url: sanitizeImageUrl(o.logo_url, prefix ?? publicAssetsPrefix()) || null,
  }
}

/**
 * Seed a theme from the cached AI brand profile's palette. Colors only SEED the
 * draft — publish freezes them into published_content; a later profile change
 * has zero effect on a live site until re-derived + re-published.
 */
export function deriveThemeFromProfile(profile: Partial<BrandProfile> | null | undefined): ClandTheme {
  const palette = Array.isArray(profile?.color_palette) ? profile!.color_palette : []
  const hexes = palette.map((p) => normalizeHex(p?.hex || '')).filter(Boolean) as string[]
  if (hexes.length === 0) return { ...DEFAULT_THEME }
  const primary = hexes[0]
  const secondary = hexes[1] || primary
  const accent = hexes[2] || hexes[1] || primary
  return {
    primary,
    secondary,
    accent,
    // A readable body-text color derived from the primary (dark on light / vice versa).
    text: bestTextColor(primary) === '#ffffff' ? '#f9fafb' : '#111827',
    font_key: 'modern_sans',
    logo_url: null,
  }
}

/* ---------------------------- section registry --------------------------- */

interface SanitizeCtx {
  imagePrefix: string
}

/**
 * The section catalog. Each type owns its `defaults` (a fresh blank section body)
 * and `sanitize` (raw jsonb → safe typed fields). validateClientLandingContent
 * ITERATES this registry — adding a section type later is one entry here + one
 * renderer branch, with zero edits to shared validation.
 */
interface SectionSpec {
  defaults: () => Omit<ClandSection, 'id' | 'type' | 'enabled'>
  sanitize: (o: Record<string, unknown>, ctx: SanitizeCtx) => Omit<ClandSection, 'id' | 'type' | 'enabled'>
}

function sanitizeServiceItems(v: unknown): ClandServiceItem[] {
  if (!Array.isArray(v)) return []
  const out: ClandServiceItem[] = []
  for (const raw of v) {
    const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
    const title = str(o.title, MAX_HEADING)
    const description = str(o.description, MAX_BODY)
    if (!title && !description) continue
    out.push({ title, description })
    if (out.length >= MAX_SERVICE_ITEMS) break
  }
  return out
}

function sanitizeGalleryImages(v: unknown, ctx: SanitizeCtx): ClandGalleryImage[] {
  if (!Array.isArray(v)) return []
  const out: ClandGalleryImage[] = []
  for (const raw of v) {
    const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
    const image_url = sanitizeImageUrl(o.image_url, ctx.imagePrefix)
    if (!image_url) continue // an image-less gallery entry is meaningless
    out.push({ image_url, caption: str(o.caption, MAX_SHORT) })
    if (out.length >= MAX_GALLERY_IMAGES) break
  }
  return out
}

function sanitizeContactLinks(v: unknown): ClandContactLink[] {
  if (!Array.isArray(v)) return []
  const out: ClandContactLink[] = []
  for (const raw of v) {
    const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
    const href = sanitizeLinkHref(o.href)
    if (!href) continue // a link with no safe href is dropped
    out.push({ label: str(o.label, MAX_SHORT), href })
    if (out.length >= MAX_CONTACT_LINKS) break
  }
  return out
}

const SECTION_SPECS: Record<ClandSectionType, SectionSpec> = {
  hero: {
    defaults: () => ({ headline: '', subheadline: '', cta_label: '', cta_href: '' }),
    sanitize: (o) => ({
      headline: str(o.headline, MAX_HEADING),
      subheadline: str(o.subheadline, MAX_BODY),
      cta_label: str(o.cta_label, MAX_SHORT),
      cta_href: sanitizeLinkHref(o.cta_href),
    }),
  },
  about: {
    defaults: () => ({ heading: '', body: '' }),
    sanitize: (o) => ({ heading: str(o.heading, MAX_HEADING), body: str(o.body, MAX_BODY) }),
  },
  services: {
    defaults: () => ({ heading: '', items: [] }),
    sanitize: (o) => ({ heading: str(o.heading, MAX_HEADING), items: sanitizeServiceItems(o.items) }),
  },
  gallery: {
    defaults: () => ({ heading: '', images: [] }),
    sanitize: (o, ctx) => ({ heading: str(o.heading, MAX_HEADING), images: sanitizeGalleryImages(o.images, ctx) }),
  },
  contact: {
    defaults: () => ({ heading: '', email: '', phone: '', links: [] }),
    sanitize: (o) => ({
      heading: str(o.heading, MAX_HEADING),
      email: str(o.email, MAX_SHORT),
      phone: str(o.phone, MAX_SHORT),
      links: sanitizeContactLinks(o.links),
    }),
  },
  custom_text: {
    defaults: () => ({ heading: '', body: '' }),
    sanitize: (o) => ({ heading: str(o.heading, MAX_HEADING), body: str(o.body, MAX_BODY) }),
  },
}

export const SECTION_TYPE_LABELS: Record<ClandSectionType, string> = {
  hero: 'Hero',
  about: 'About',
  services: 'Services',
  gallery: 'Gallery',
  contact: 'Contact',
  custom_text: 'Custom text',
}

let sectionIdCounter = 0
/** A stable-enough id for a new section (client-side reorder key + a11y). */
export function newSectionId(type: ClandSectionType): string {
  sectionIdCounter += 1
  return `${type}_${sectionIdCounter}_${String(sectionIdCounter * 2654435761 % 100000).padStart(5, '0')}`
}

/** A fresh, blank section of the given type (enabled by default). */
export function newSection(type: ClandSectionType): ClandSection {
  return { id: newSectionId(type), type, enabled: true, ...SECTION_SPECS[type].defaults() } as ClandSection
}

/** Sanitize one raw section (unknown type → null, dropped). */
function sanitizeSection(raw: unknown, ctx: SanitizeCtx): ClandSection | null {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const type = o.type
  if (!isClandSectionType(type)) return null
  const id = str(o.id, 80) || newSectionId(type)
  const enabled = o.enabled !== false // default enabled
  return { id, type, enabled, ...SECTION_SPECS[type].sanitize(o, ctx) } as ClandSection
}

/* ----------------------------- default content --------------------------- */

/** The single v1 starting arrangement (no template registry yet). */
export function defaultSections(): ClandSection[] {
  return [newSection('hero'), newSection('about'), newSection('services'), newSection('contact')]
}

/** A complete default draft content, optionally themed from a brand profile. */
export function defaultLandingContent(
  opts: { locale?: ClandLocale; theme?: ClandTheme } = {},
): ClientLandingContent {
  return {
    locale: opts.locale && isClandLocale(opts.locale) ? opts.locale : 'en',
    theme: opts.theme ? sanitizeTheme(opts.theme) : { ...DEFAULT_THEME },
    sections: defaultSections(),
  }
}

/* ------------------------------- validation ------------------------------ */

/**
 * The single gate: layer a (possibly partial / malformed) stored value into a
 * complete, safe ClientLandingContent. Used on write AND on the public read.
 */
export function validateClientLandingContent(
  stored: Partial<ClientLandingContent> | null | undefined,
  opts: { imagePrefix?: string } = {},
): ClientLandingContent {
  const s = (stored && typeof stored === 'object' ? stored : {}) as Record<string, unknown>
  const imagePrefix = opts.imagePrefix ?? publicAssetsPrefix()
  const ctx: SanitizeCtx = { imagePrefix }
  const rawSections = Array.isArray(s.sections) ? s.sections : []
  const sections: ClandSection[] = []
  for (const raw of rawSections) {
    const sec = sanitizeSection(raw, ctx)
    if (sec) sections.push(sec)
    if (sections.length >= MAX_SECTIONS) break
  }
  return {
    locale: isClandLocale(s.locale) ? s.locale : 'en',
    theme: sanitizeTheme(s.theme, imagePrefix),
    sections,
  }
}

/** Deep-equality after normalization — drives the "unpublished changes" badge. */
export function landingContentEqual(
  a: ClientLandingContent | null | undefined,
  b: ClientLandingContent | null | undefined,
): boolean {
  return JSON.stringify(validateClientLandingContent(a)) === JSON.stringify(validateClientLandingContent(b))
}

/* --------------------------- public projection --------------------------- */

/**
 * Strip a site row down to the PUBLIC-safe subset served to the unauthenticated
 * page. Never returns enrollment_id / created_by / published_by / the row. Only
 * ENABLED sections survive (disabled content never reaches the browser). Re-runs
 * the sanitizer (defense in depth).
 */
export function toPublicSite(
  site: Pick<ClientLandingSite, 'title' | 'published_content'>,
  opts: { imagePrefix?: string } = {},
): PublicClientLanding {
  const content = validateClientLandingContent(site.published_content, opts)
  return {
    title: str(site.title, MAX_HEADING),
    locale: content.locale,
    theme: content.theme,
    sections: content.sections.filter((sec) => sec.enabled),
  }
}

/* --------------------------------- slug ---------------------------------- */

/**
 * Slugify a title to lowercase-kebab (ASCII). Strips accents + non-alphanumerics.
 * Returns '' when nothing usable remains (caller supplies a fallback stem).
 */
export function slugify(title: unknown): string {
  const s = typeof title === 'string' ? title : ''
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // strip diacritics
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '')
}

/** A short lowercase-hex disambiguator (deterministic given the input seed char). */
export function slugStem(title: unknown): string {
  return slugify(title) || 'site'
}

/* --------------------------- asset bookkeeping --------------------------- */

/**
 * Every PUBLIC image URL referenced by a content (logo + gallery images).
 * Used by the query layer to clean up superseded copies on replace/unpublish
 * WITHOUT deleting an asset still referenced by the published snapshot.
 */
export function collectImageUrls(content: ClientLandingContent | null | undefined): string[] {
  const out = new Set<string>()
  if (!content) return []
  if (content.theme?.logo_url) out.add(content.theme.logo_url)
  for (const sec of content.sections || []) {
    if (sec.type === 'gallery') {
      for (const img of sec.images || []) {
        if (img.image_url) out.add(img.image_url)
      }
    }
  }
  return Array.from(out)
}

/**
 * Image URLs present in `previous` but no longer referenced by `next` OR
 * `keepAlso` (the published snapshot). These are safe to delete from the public
 * bucket. Pure — the query layer does the actual best-effort removal.
 */
export function supersededImageUrls(
  previous: ClientLandingContent | null | undefined,
  next: ClientLandingContent | null | undefined,
  keepAlso?: ClientLandingContent | null | undefined,
): string[] {
  const keep = new Set<string>([...collectImageUrls(next), ...collectImageUrls(keepAlso)])
  return collectImageUrls(previous).filter((u) => !keep.has(u))
}
