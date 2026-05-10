"use server"

import { revalidatePath } from "next/cache"
import { createClient } from "@/lib/supabase/server"
import { safeAction, type ActionResult } from "@/lib/server-action"
import {
  type Actor,
  addEntry,
  type CatalogEntry,
  type CatalogPendingReview,
  deprecateEntry,
  getEntry,
  type PendingReviewStatus,
  renameEntry,
  resolvePendingReview,
  restoreEntry,
  tagEntry,
} from "@/lib/catalog/framework"

const SERVICES = "services"

async function uiActor(): Promise<Actor> {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  return { kind: "ui", userId: user?.id ?? null }
}

export async function addCatalogEntry(input: {
  catalog_id: string
  slug: string
  display_name: string
  description?: string
  status: "active" | "deprecated" | "exception_only"
  tags: string[]
  reason: string
}): Promise<ActionResult<CatalogEntry>> {
  return safeAction(async () => {
    const actor = await uiActor()
    const created = await addEntry(
      input.catalog_id,
      {
        slug: input.slug,
        display_name: input.display_name,
        status: input.status,
        description: input.description?.trim() ? input.description : null,
        tags: input.tags,
      },
      input.reason,
      actor,
    )
    revalidatePath("/catalog")
    return created
  })
}

export async function renameCatalogEntry(input: {
  catalog_id: string
  slug: string
  new_display_name: string
  reason: string
}): Promise<ActionResult<CatalogEntry>> {
  return safeAction(async () => {
    const actor = await uiActor()
    const entry = await getEntry(input.catalog_id, input.slug)
    if (!entry) throw new Error(`Entry not found: ${input.catalog_id}/${input.slug}`)
    const updated = await renameEntry(entry.id, input.new_display_name, input.reason, actor)
    revalidatePath("/catalog")
    return updated
  })
}

export async function retagCatalogEntry(input: {
  catalog_id: string
  slug: string
  tags: string[]
  reason: string
}): Promise<ActionResult<CatalogEntry>> {
  return safeAction(async () => {
    const actor = await uiActor()
    const entry = await getEntry(input.catalog_id, input.slug)
    if (!entry) throw new Error(`Entry not found: ${input.catalog_id}/${input.slug}`)
    const updated = await tagEntry(entry.id, input.tags, input.reason, actor)
    revalidatePath("/catalog")
    return updated
  })
}

export async function deprecateCatalogEntry(input: {
  catalog_id: string
  slug: string
  reason: string
}): Promise<ActionResult<CatalogEntry>> {
  return safeAction(async () => {
    const actor = await uiActor()
    const entry = await getEntry(input.catalog_id, input.slug)
    if (!entry) throw new Error(`Entry not found: ${input.catalog_id}/${input.slug}`)
    const updated = await deprecateEntry(entry.id, input.reason, actor)
    revalidatePath("/catalog")
    return updated
  })
}

export async function restoreCatalogEntry(input: {
  catalog_id: string
  slug: string
  reason: string
}): Promise<ActionResult<CatalogEntry>> {
  return safeAction(async () => {
    const actor = await uiActor()
    const entry = await getEntry(input.catalog_id, input.slug)
    if (!entry) throw new Error(`Entry not found: ${input.catalog_id}/${input.slug}`)
    const updated = await restoreEntry(entry.id, input.reason, actor)
    revalidatePath("/catalog")
    return updated
  })
}

export async function resolvePendingAlias(input: {
  pending_id: string
  catalog_id: string
  resolved_to_slug: string
  reason: string
}): Promise<ActionResult<CatalogPendingReview>> {
  return safeAction(async () => {
    const actor = await uiActor()
    const target = await getEntry(input.catalog_id, input.resolved_to_slug)
    if (!target) {
      throw new Error(
        `Slug '${input.resolved_to_slug}' not found in catalog '${input.catalog_id}'`,
      )
    }
    const resolved = await resolvePendingReview(
      input.pending_id,
      "approved_aliased",
      target.id,
      input.reason,
      actor,
    )
    revalidatePath("/catalog")
    return resolved
  })
}

export async function rejectPending(input: {
  pending_id: string
  reason: string
}): Promise<ActionResult<CatalogPendingReview>> {
  return safeAction(async () => {
    const actor = await uiActor()
    const resolved = await resolvePendingReview(
      input.pending_id,
      "rejected",
      null,
      input.reason,
      actor,
    )
    revalidatePath("/catalog")
    return resolved
  })
}

// Re-export for the page so it can list while sharing the same import.
export { SERVICES as DEFAULT_CATALOG_ID }
export type { PendingReviewStatus }
