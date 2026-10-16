"use server"

/**
 * The "Waiting on" list — admin actions (dev job 40235e3c, Antonio 2026-10-16). The kinds are rows of the catalog `step_wait_kinds`,
 * written through the catalog framework (decision log, author stamp). ADMIN-ONLY, like editing a service's steps.
 *
 *   - a kind is added with a NAME and a BEHAVIOUR (`other` = waits on someone else, `date` = waits for a date); the behaviour is fixed
 *     for good (changing it would silently move live jobs between lists), to change one add a new kind and point the steps at it;
 *   - the slug is made from the name and never changes (steps store the slug); renaming changes only the name shown;
 *   - retiring keeps the steps that use the kind working (they keep their meaning); it only stops offering it for new picks;
 *   - a retired name is RESTORED, never added twice.
 * Inert until the migration has created the catalog (every action then says so in plain words).
 */

import { revalidatePath } from "next/cache"
import { createClient } from "@/lib/supabase/server"
import { isAdmin } from "@/lib/auth"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { addEntry, deprecateEntry, getEntry, listEntries, renameEntry, restoreEntry, type Actor } from "@/lib/catalog/framework"
import { WAIT_KINDS_CATALOG } from "@/lib/services/wait-kinds-load"
import { isUsableKindSlug, slugFromName } from "@/lib/open-services/wait-kinds"
import { BUILTIN_WAIT_KINDS } from "@/lib/open-services/types"

export interface WaitKindAdminRow {
  slug: string
  name: string
  behaviour: "other" | "date"
  retired: boolean
  /** Steps (all services) that currently use this kind. */
  usedBy: number
}

export interface WaitKindsAdminView {
  /** false = the migration has not run yet: the list cannot be edited. */
  defined: boolean
  rows: WaitKindAdminRow[]
}

export type WaitKindResult = { ok: true } | { ok: false; error: string }

const NOT_SET_UP =
  "The waiting-on list is not set up yet: the database step that creates it has not been run. Nothing has been changed."

async function requireAdminActor(): Promise<Actor> {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isAdmin(user)) throw new Error("Only an admin can change the waiting-on list.")
  return { kind: "ui", userId: user.id }
}

async function catalogExists(): Promise<boolean> {
  const { data, error } = await supabaseAdmin.from("catalog_definitions").select("id").eq("id", WAIT_KINDS_CATALOG).maybeSingle()
  if (error) throw new Error(`Could not read the waiting-on list: ${error.message}`)
  return !!data
}

function fail(err: unknown, fallback: string): WaitKindResult {
  return { ok: false, error: err instanceof Error && err.message ? err.message : fallback }
}

export async function loadWaitKindsAdmin(): Promise<WaitKindsAdminView | { error: string }> {
  try {
    await requireAdminActor()
    if (!(await catalogExists())) return { defined: false, rows: [] }
    const entries = await listEntries(WAIT_KINDS_CATALOG, { includeDeprecated: true })
    const { data: steps, error } = await supabaseAdmin.from("pipeline_stages").select("waiting_on").not("waiting_on", "is", null)
    if (error) throw new Error(`Could not count the steps: ${error.message}`)
    const used = new Map<string, number>()
    for (const s of (steps ?? []) as Array<{ waiting_on: string | null }>) {
      if (s.waiting_on) used.set(s.waiting_on, (used.get(s.waiting_on) ?? 0) + 1)
    }
    const rows: WaitKindAdminRow[] = entries
      .filter(e => e.status === "active" || e.status === "deprecated")
      .map(e => ({
        slug: e.slug,
        name: e.display_name,
        behaviour: e.metadata?.behaviour === "date" ? ("date" as const) : ("other" as const),
        retired: e.status === "deprecated",
        usedBy: used.get(e.slug) ?? 0,
      }))
      .sort((a, b) => Number(a.retired) - Number(b.retired) || a.name.localeCompare(b.name))
    return { defined: true, rows }
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Could not read the waiting-on list." }
  }
}

export async function addWaitKind(input: { name: string; behaviour: string }): Promise<WaitKindResult> {
  try {
    const actor = await requireAdminActor()
    if (!(await catalogExists())) return { ok: false, error: NOT_SET_UP }
    const name = (input.name ?? "").trim().replace(/\s+/g, " ")
    if (name.length < 2 || name.length > 60) return { ok: false, error: "Give the kind a name of 2 to 60 characters." }
    if (input.behaviour !== "other" && input.behaviour !== "date") {
      return { ok: false, error: 'Choose what the kind means: "waits on someone else" or "waits for a date".' }
    }
    let slug = slugFromName(name)
    // A slug must start with a letter ("1099 filing office" → k_1099_filing_office).
    if (/^[0-9]/.test(slug)) slug = `k_${slug}`.slice(0, 41)
    if (!isUsableKindSlug(slug)) {
      return { ok: false, error: `"${name}" cannot be used as a name here (it is reserved, or has no letters or digits). Pick another name.` }
    }
    // The same name twice would give two identical chips: refuse by NAME as well as by slug (retired ones included).
    const wanted = name.toLowerCase()
    const all = await listEntries(WAIT_KINDS_CATALOG, { includeDeprecated: true })
    const existing = (await getEntry(WAIT_KINDS_CATALOG, slug)) ?? all.find(e => (e.display_name ?? "").trim().replace(/\s+/g, " ").toLowerCase() === wanted) ?? null
    if (existing) {
      return {
        ok: false,
        error: existing.status === "active"
          ? `"${existing.display_name}" is already in the list.`
          : `"${existing.display_name}" is in the list but retired. Restore it instead of adding it again.`,
      }
    }
    await addEntry(WAIT_KINDS_CATALOG, { slug, display_name: name, status: "active", metadata: { behaviour: input.behaviour } }, "Added from the Service Catalog (waiting-on list)", actor)
    revalidatePath("/service-catalog")
    revalidatePath("/new-calendar")
    revalidatePath("/calendar/open-services")
    return { ok: true }
  } catch (err) {
    return fail(err, "Could not add the kind.")
  }
}

async function entryFor(slug: string) {
  if (!(await catalogExists())) throw new Error(NOT_SET_UP)
  if ((Object.keys(BUILTIN_WAIT_KINDS) as string[]).includes(slug)) throw new Error("This kind is built in and cannot be changed here.")
  const entry = await getEntry(WAIT_KINDS_CATALOG, slug)
  if (!entry) throw new Error("That kind is not in the list any more. Reload the page.")
  return entry
}

export async function renameWaitKind(input: { slug: string; name: string }): Promise<WaitKindResult> {
  try {
    const actor = await requireAdminActor()
    const entry = await entryFor(input.slug)
    const name = (input.name ?? "").trim().replace(/\s+/g, " ")
    if (name.length < 2 || name.length > 60) return { ok: false, error: "Give the kind a name of 2 to 60 characters." }
    if (name === entry.display_name) return { ok: true }
    // Two kinds with the same name would give two identical chips: refuse by NAME, like adding (retired ones included, this one excluded).
    const all = await listEntries(WAIT_KINDS_CATALOG, { includeDeprecated: true })
    const clash = all.find(e => e.slug !== entry.slug && (e.display_name ?? "").trim().replace(/\s+/g, " ").toLowerCase() === name.toLowerCase())
    if (clash) return { ok: false, error: `"${clash.display_name}" is already in the list${clash.status === "active" ? "" : " (retired)"}. Pick another name.` }
    await renameEntry(entry.id, name, "Renamed from the Service Catalog (waiting-on list)", actor)
    revalidatePath("/service-catalog")
    revalidatePath("/new-calendar")
    revalidatePath("/calendar/open-services")
    return { ok: true }
  } catch (err) {
    return fail(err, "Could not rename the kind.")
  }
}

export async function retireWaitKind(input: { slug: string }): Promise<WaitKindResult> {
  try {
    const actor = await requireAdminActor()
    const entry = await entryFor(input.slug)
    if (entry.status === "deprecated") return { ok: true }
    await deprecateEntry(entry.id, "Retired from the Service Catalog (waiting-on list)", actor)
    revalidatePath("/service-catalog")
    revalidatePath("/new-calendar")
    revalidatePath("/calendar/open-services")
    return { ok: true }
  } catch (err) {
    return fail(err, "Could not retire the kind.")
  }
}

export async function restoreWaitKind(input: { slug: string }): Promise<WaitKindResult> {
  try {
    const actor = await requireAdminActor()
    const entry = await entryFor(input.slug)
    if (entry.status === "active") return { ok: true }
    await restoreEntry(entry.id, "Restored from the Service Catalog (waiting-on list)", actor)
    revalidatePath("/service-catalog")
    revalidatePath("/new-calendar")
    revalidatePath("/calendar/open-services")
    return { ok: true }
  } catch (err) {
    return fail(err, "Could not restore the kind.")
  }
}
