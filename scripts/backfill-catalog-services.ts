/* eslint-disable no-console -- CLI migration script reports progress via stdout. */
/**
 * Backfill catalog_entries.metadata with the service_catalog projected fields,
 * so that the upcoming service_catalog → VIEW cutover can project from
 * catalog_entries without any data loss.
 *
 * Idempotent: rerunning skips slugs that already carry the legacy projection.
 *
 * Per the plan, every service_catalog row that has a matching catalog_entries
 * row gets its metadata patched. Orphan service_catalog slugs (no matching
 * catalog_entries row) are created via addEntry first, then patched.
 *
 * Run against sandbox first:
 *   npx tsx scripts/backfill-catalog-services.ts
 *
 * Reads NEXT_PUBLIC_SUPABASE_URL from .env.local to determine the target env.
 * Refuses to run unless SUPABASE_URL contains the sandbox ref.
 */

import { config } from "dotenv"
config({ path: ".env.local" })

import { supabaseAdmin } from "@/lib/supabase-admin"
import {
  addEntry,
  getEntry,
  updateMetadata,
  type Actor,
} from "@/lib/catalog/framework"

const SANDBOX_REF = "xjcxlmlpeywtwkhstjlw"
const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? ""
if (!url.includes(SANDBOX_REF)) {
  console.error(
    `Refusing to run: NEXT_PUBLIC_SUPABASE_URL must point to sandbox ref ${SANDBOX_REF}.`,
  )
  console.error(`Currently: ${url}`)
  process.exit(1)
}

const ACTOR: Actor = { userId: null, kind: "migration" }
const REASON =
  "Backfill: project service_catalog columns into catalog_entries.metadata ahead of service_catalog → VIEW cutover. Marks legacy_in_service_catalog=true on rows that should remain visible to legacy readers."

interface ServiceCatalogRow {
  id: string
  slug: string
  name: string
  pipeline: string | null
  contract_type: string | null
  has_annual: boolean | null
  default_price: number | null
  default_currency: string | null
  sort_order: number | null
  category: string | null
  description: string | null
  supports_quantity: boolean | null
  default_service_context: string | null
  active: boolean
}

function projectionFromServiceCatalog(row: ServiceCatalogRow): Record<string, unknown> {
  return {
    legacy_in_service_catalog: true,
    legacy_name: row.name,
    pipeline: row.pipeline,
    contract_type: row.contract_type,
    has_annual: row.has_annual,
    default_price: row.default_price,
    default_currency: row.default_currency,
    sort_order: row.sort_order,
    category: row.category,
    description_legacy: row.description,
    supports_quantity: row.supports_quantity,
    default_service_context: row.default_service_context,
  }
}

async function main() {
  const { data: scRows, error: scErr } = await supabaseAdmin
    .from("service_catalog")
    .select("*")
    .order("sort_order", { ascending: true })
  if (scErr) throw new Error(`fetch service_catalog: ${scErr.message}`)
  if (!scRows?.length) throw new Error("service_catalog is empty — nothing to do")

  console.log(`Loaded ${scRows.length} service_catalog rows`)

  let created = 0
  let updated = 0
  let skipped = 0
  const errors: Array<{ slug: string; reason: string }> = []

  for (const row of scRows as ServiceCatalogRow[]) {
    try {
      let entry = await getEntry("services", row.slug)
      if (!entry) {
        console.log(`  + creating catalog_entries row for slug=${row.slug}`)
        entry = await addEntry(
          "services",
          {
            slug: row.slug,
            display_name: row.name,
            description: row.description,
            tags: [],
            metadata: projectionFromServiceCatalog(row),
            status: row.active ? "active" : "deprecated",
          },
          REASON,
          ACTOR,
        )
        created++
        continue
      }

      const existingMeta = (entry.metadata ?? {}) as Record<string, unknown>
      if (existingMeta.legacy_in_service_catalog === true) {
        skipped++
        continue
      }

      const merged = { ...existingMeta, ...projectionFromServiceCatalog(row) }
      await updateMetadata(entry.id, merged, REASON, ACTOR)
      updated++
      console.log(`  ~ patched metadata for slug=${row.slug}`)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      errors.push({ slug: row.slug, reason: msg })
      console.error(`  ! error on slug=${row.slug}: ${msg}`)
    }
  }

  console.log("\n=== Summary ===")
  console.log(`  created: ${created}`)
  console.log(`  updated: ${updated}`)
  console.log(`  skipped (already backfilled): ${skipped}`)
  console.log(`  errors:  ${errors.length}`)
  if (errors.length) {
    console.log("\nFailures:")
    for (const e of errors) console.log(`  - ${e.slug}: ${e.reason}`)
    process.exit(1)
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
