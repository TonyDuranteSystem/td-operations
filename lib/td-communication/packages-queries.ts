/**
 * TD Communication — packages data layer (server-side, service role).
 *
 * td_comm_packages is RLS ON with NO policy (like every td_comm_* table): the
 * browser never queries it; these helpers use supabaseAdmin (RLS bypass) and
 * assume the API layer already authorized the caller (staff read, admin write).
 *
 * The table is not in the generated Supabase types, so we go through an untyped
 * client and shape rows via shapePackage().
 */

import { supabaseAdmin } from '@/lib/supabase-admin'
import { shapePackage, type PackageWriteInput } from './packages'
import type { TdCommPackage } from './types'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any

const COLUMNS =
  'slug, name_en, name_it, description_en, description_it, price_usd, delivery_days, max_revisions, payment_timing, highlighted, active, sort_order, includes, upsell_from, created_at, updated_at'

/** Postgres unique-violation code. */
const PG_UNIQUE_VIOLATION = '23505'

/** All packages ordered by sort_order. Excludes retired (active=false) unless includeInactive. */
export async function listPackages(opts: { includeInactive?: boolean } = {}): Promise<TdCommPackage[]> {
  let q = db.from('td_comm_packages').select(COLUMNS).order('sort_order', { ascending: true })
  if (!opts.includeInactive) q = q.eq('active', true)
  const { data, error } = await q
  if (error) throw new Error(error.message)
  return (data ?? []).map(shapePackage)
}

/** Insert a new package. Caller must validate first (validatePackageInput). */
export async function createPackage(input: PackageWriteInput): Promise<TdCommPackage> {
  const now = new Date().toISOString()
  const row = {
    slug: input.slug,
    name_en: input.name_en,
    name_it: input.name_it ?? null,
    description_en: input.description_en ?? null,
    description_it: input.description_it ?? null,
    price_usd: input.price_usd ?? null,
    delivery_days: input.delivery_days ?? null,
    max_revisions: input.max_revisions ?? 2,
    payment_timing: input.payment_timing ?? 'on_approval',
    highlighted: input.highlighted ?? false,
    active: input.active ?? true,
    sort_order: input.sort_order ?? 0,
    includes: input.includes ?? [],
    upsell_from: input.upsell_from ?? [],
    created_at: now,
    updated_at: now,
  }
  const { data, error } = await db.from('td_comm_packages').insert(row).select(COLUMNS).maybeSingle()
  if (error) {
    if (error.code === PG_UNIQUE_VIOLATION) throw new Error(`A package with slug "${input.slug}" already exists.`)
    throw new Error(error.message)
  }
  if (!data) throw new Error('Package was not created.')
  return shapePackage(data)
}

/** Update a package by slug. The slug itself is immutable (never patched). */
export async function updatePackage(slug: string, input: PackageWriteInput): Promise<TdCommPackage> {
  // Whitelist mutable fields; explicitly drop slug so the PK can't change.
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() }
  const fields: (keyof PackageWriteInput)[] = [
    'name_en', 'name_it', 'description_en', 'description_it', 'price_usd', 'delivery_days',
    'max_revisions', 'payment_timing', 'highlighted', 'active', 'sort_order', 'includes', 'upsell_from',
  ]
  for (const f of fields) {
    if (input[f] !== undefined) patch[f] = input[f]
  }
  const { data, error } = await db
    .from('td_comm_packages')
    .update(patch)
    .eq('slug', slug)
    .select(COLUMNS)
    .maybeSingle()
  if (error) throw new Error(error.message)
  if (!data) throw new Error('Package not found.')
  return shapePackage(data)
}

/** Soft-delete (active=false). Keeps the row so existing enrollments still resolve. */
export async function softDeletePackage(slug: string): Promise<void> {
  const { data, error } = await db
    .from('td_comm_packages')
    .update({ active: false, updated_at: new Date().toISOString() })
    .eq('slug', slug)
    .select('slug')
    .maybeSingle()
  if (error) throw new Error(error.message)
  if (!data) throw new Error('Package not found.')
}
