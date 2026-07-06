/**
 * TD Communication — deliverables pure logic (no DB / no I/O).
 *
 * Drives the deliverables manager in the creative-brief panel. Kept
 * side-effect-free so it is unit-testable without a database (R086) and safe to
 * import on the client.
 *
 * Validation policy: deliverables are a KNOWN, finite set of design/image/doc
 * formats, so this uses an ALLOW-LIST (unlike the chat attachment block-list).
 * SVG is allowed here (the chat blocks it) because deliverables live in a
 * PRIVATE bucket served via signed URLs and are only ever previewed inside an
 * <img> (no script execution) or downloaded as an attachment.
 */

import type { CommDeliverable, DeliverableType } from './types'

/* -------------------------------------------------------------------------- */
/* Types                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The types offered in the MANUAL upload dropdown (deliverables manager). The
 * Phase 12 tool-only types (`mockup`, `asset_kit`) are intentionally absent —
 * they are produced by the design tools and saved via the isolated design-assets
 * route, never hand-uploaded here.
 */
export const DELIVERABLE_TYPES: readonly { value: DeliverableType; label: string }[] = [
  { value: 'logo_draft', label: 'Logo Draft' },
  { value: 'logo_final', label: 'Logo Final' },
  { value: 'landing_page', label: 'Landing Page' },
  { value: 'brand_guide', label: 'Brand Guide' },
  { value: 'business_card', label: 'Business Card' },
  { value: 'other', label: 'Other' },
] as const

/** Labels for EVERY type (incl. the tool-only ones) so saved rows render nicely. */
export const DELIVERABLE_TYPE_LABELS: Record<DeliverableType, string> = {
  logo_draft: 'Logo Draft',
  logo_final: 'Logo Final',
  landing_page: 'Landing Page',
  brand_guide: 'Brand Guide',
  business_card: 'Business Card',
  other: 'Other',
  mockup: 'Mockup',
  asset_kit: 'Asset Kit',
  social_kit: 'Social Sharing Kit',
}

/** Tool-only deliverable types (Phase 12), saved via the design-assets route. */
export const DESIGN_ASSET_TYPES = ['mockup', 'asset_kit'] as const
export type DesignAssetType = (typeof DESIGN_ASSET_TYPES)[number]

export function isDesignAssetType(v: unknown): v is DesignAssetType {
  return typeof v === 'string' && (DESIGN_ASSET_TYPES as readonly string[]).includes(v)
}

export function deliverableTypeLabel(type: string): string {
  return DELIVERABLE_TYPE_LABELS[type as DeliverableType] ?? 'Other'
}

export function isDeliverableType(v: unknown): v is DeliverableType {
  return typeof v === 'string' && v in DELIVERABLE_TYPE_LABELS
}

/* -------------------------------------------------------------------------- */
/* Validation                                                                  */
/* -------------------------------------------------------------------------- */

export const DELIVERABLE_MAX_MB = 100
export const DELIVERABLE_MAX_BYTES = DELIVERABLE_MAX_MB * 1024 * 1024

/** Allowed deliverable file extensions (images + common design/doc formats). */
export const DELIVERABLE_ALLOWED_EXTENSIONS = new Set<string>([
  'png', 'jpg', 'jpeg', 'webp', 'gif', 'svg', // images
  'pdf', 'ai', 'psd', 'eps', 'tiff', 'tif', // design / docs
])

/** Extensions we can render as an inline thumbnail in an <img>. */
const IMAGE_EXTENSIONS = new Set<string>(['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg'])

/** Lower-cased, punctuation-stripped extension (no leading dot). '' if none. */
export function getExtension(fileName: string): string {
  const parts = (fileName || '').split('.')
  if (parts.length < 2) return ''
  return (parts.pop() || '').toLowerCase().replace(/[^a-z0-9]/g, '')
}

/**
 * Validate a deliverable against the size cap and the allow-list. Pure — safe on
 * client and server. Returns a user-friendly message, or null when allowed.
 */
export function validateDeliverable(fileName: string, sizeBytes: number): string | null {
  if (sizeBytes > DELIVERABLE_MAX_BYTES) {
    const mb = (sizeBytes / 1024 / 1024).toFixed(1)
    return `File too large: ${mb} MB. Maximum allowed: ${DELIVERABLE_MAX_MB} MB.`
  }
  const ext = getExtension(fileName)
  if (!ext) {
    return 'This file has no extension. Allowed: images (PNG, JPG, SVG…) and design files (PDF, AI, PSD, EPS).'
  }
  if (!DELIVERABLE_ALLOWED_EXTENSIONS.has(ext)) {
    return `.${ext} files aren't supported as deliverables. Allowed: images (PNG, JPG, SVG, WebP, GIF) and design files (PDF, AI, PSD, EPS, TIFF).`
  }
  return null
}

/** True when the file can be shown as an inline image thumbnail. */
export function isImageThumbnailable(fileName: string, mimeType?: string | null): boolean {
  const ext = getExtension(fileName)
  if (ext && IMAGE_EXTENSIONS.has(ext)) return true
  const mime = (mimeType || '').toLowerCase().split(';')[0].trim()
  return mime.startsWith('image/')
}

/* -------------------------------------------------------------------------- */
/* Concept / version numbering                                                 */
/* -------------------------------------------------------------------------- */

type ConceptVersionLike = Pick<CommDeliverable, 'concept_number' | 'version_number'>

/** Next free concept number (max existing + 1, or 1 when there are none). */
export function nextConceptNumber(existing: Pick<CommDeliverable, 'concept_number'>[]): number {
  let max = 0
  for (const d of existing) {
    const n = Number(d.concept_number)
    if (Number.isFinite(n) && n > max) max = n
  }
  return max + 1
}

/** Next free version number within a concept (max existing in that concept + 1). */
export function nextVersionForConcept(existing: ConceptVersionLike[], concept: number): number {
  let max = 0
  for (const d of existing) {
    if (Number(d.concept_number) !== concept) continue
    const n = Number(d.version_number)
    if (Number.isFinite(n) && n > max) max = n
  }
  return max + 1
}

/* -------------------------------------------------------------------------- */
/* Grouping for the UI (concept tabs + version history)                        */
/* -------------------------------------------------------------------------- */

export interface ConceptGroup {
  concept: number
  versions: CommDeliverable[]
}

/**
 * Group deliverables into concepts (ascending), each holding its versions
 * sorted newest-first (highest version_number, then most recent created_at).
 * Tolerant of arbitrary / sparse concept and version numbers.
 */
export function groupByConcept(deliverables: CommDeliverable[]): ConceptGroup[] {
  const byConcept = new Map<number, CommDeliverable[]>()
  for (const d of deliverables) {
    const c = Number(d.concept_number) || 1
    const arr = byConcept.get(c)
    if (arr) arr.push(d)
    else byConcept.set(c, [d])
  }
  return Array.from(byConcept.keys())
    .sort((a, b) => a - b)
    .map((concept) => ({
      concept,
      versions: (byConcept.get(concept) ?? []).slice().sort((a, b) => {
        const v = (Number(b.version_number) || 0) - (Number(a.version_number) || 0)
        if (v !== 0) return v
        return (b.created_at || '').localeCompare(a.created_at || '')
      }),
    }))
}

/** Display label for a concept number: 1 → "Concept A", 2 → "Concept B" … */
export function conceptLabel(concept: number): string {
  const n = Number(concept)
  if (Number.isFinite(n) && n >= 1 && n <= 26) {
    return `Concept ${String.fromCharCode(64 + n)}`
  }
  return `Concept ${concept}`
}
