/**
 * TD Communication — package validation + normalization (pure, client-safe).
 *
 * No server imports: usable from the admin UI and the API route. The actual
 * reads/writes live in ./packages-queries (service role). Types in ./types.
 */

import type { TdCommPackage, PackagePaymentTiming } from './types'

export const PAYMENT_TIMINGS: readonly PackagePaymentTiming[] = ['upfront', 'on_approval']

/** lowercase, digits, single hyphens (e.g. "logo-landing"). */
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** Fields a write accepts. `slug` is only honored on create (immutable after). */
export interface PackageWriteInput {
  slug?: string
  name_en?: string
  name_it?: string | null
  description_en?: string | null
  description_it?: string | null
  price_usd?: number | null
  delivery_days?: number | null
  max_revisions?: number
  payment_timing?: PackagePaymentTiming
  highlighted?: boolean
  active?: boolean
  sort_order?: number
  includes?: string[]
  upsell_from?: string[]
  includes_landing?: boolean
}

export interface ValidationResult {
  valid: boolean
  errors: string[]
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

/**
 * Validate a package create/edit payload. On create, slug is required and must
 * be kebab-case. On edit, slug is ignored (immutable — changing the PK would
 * orphan enrollments that reference it).
 */
export function validatePackageInput(
  input: PackageWriteInput,
  opts: { isCreate: boolean },
): ValidationResult {
  const errors: string[] = []

  if (opts.isCreate) {
    if (!input.slug || !input.slug.trim()) {
      errors.push('Slug is required.')
    } else if (!SLUG_RE.test(input.slug)) {
      errors.push('Slug must be lowercase letters, numbers, and single hyphens (e.g. "logo-landing").')
    }
  }

  // name_en required on create; on edit, if provided it must be non-empty.
  if (opts.isCreate || input.name_en !== undefined) {
    if (!input.name_en || !input.name_en.trim()) errors.push('English name is required.')
  }

  if (input.price_usd !== undefined && input.price_usd !== null) {
    if (!isFiniteNumber(input.price_usd) || input.price_usd < 0) errors.push('Price must be a number ≥ 0.')
  }
  if (input.delivery_days !== undefined && input.delivery_days !== null) {
    if (!Number.isInteger(input.delivery_days) || input.delivery_days < 0) {
      errors.push('Delivery days must be a whole number ≥ 0.')
    }
  }
  if (input.max_revisions !== undefined) {
    if (!Number.isInteger(input.max_revisions) || input.max_revisions < 0) {
      errors.push('Max revisions must be a whole number ≥ 0.')
    }
  }
  if (input.payment_timing !== undefined && !PAYMENT_TIMINGS.includes(input.payment_timing)) {
    errors.push('Payment timing must be "upfront" or "on_approval".')
  }
  if (input.sort_order !== undefined && !Number.isInteger(input.sort_order)) {
    errors.push('Sort order must be a whole number.')
  }
  if (input.includes !== undefined) {
    if (!Array.isArray(input.includes) || input.includes.some((s) => typeof s !== 'string')) {
      errors.push('Includes must be a list of text items.')
    }
  }
  if (input.upsell_from !== undefined) {
    if (!Array.isArray(input.upsell_from) || input.upsell_from.some((s) => typeof s !== 'string')) {
      errors.push('Upsell-from must be a list of package slugs.')
    }
  }

  return { valid: errors.length === 0, errors }
}

/** Shape a raw DB row into a typed package (defensive defaults for nullable jsonb/array). */
export function shapePackage(row: Record<string, unknown>): TdCommPackage {
  return {
    slug: String(row.slug),
    name_en: String(row.name_en ?? ''),
    name_it: (row.name_it as string | null) ?? null,
    description_en: (row.description_en as string | null) ?? null,
    description_it: (row.description_it as string | null) ?? null,
    price_usd: row.price_usd === null || row.price_usd === undefined ? null : Number(row.price_usd),
    delivery_days:
      row.delivery_days === null || row.delivery_days === undefined ? null : Number(row.delivery_days),
    max_revisions: Number(row.max_revisions ?? 2),
    payment_timing: (row.payment_timing as PackagePaymentTiming) ?? 'on_approval',
    highlighted: Boolean(row.highlighted),
    active: row.active === undefined ? true : Boolean(row.active),
    sort_order: Number(row.sort_order ?? 0),
    includes: Array.isArray(row.includes) ? (row.includes as string[]) : [],
    upsell_from: Array.isArray(row.upsell_from) ? (row.upsell_from as string[]) : [],
    includes_landing: Boolean(row.includes_landing),
    created_at: String(row.created_at ?? ''),
    updated_at: String(row.updated_at ?? ''),
  }
}
