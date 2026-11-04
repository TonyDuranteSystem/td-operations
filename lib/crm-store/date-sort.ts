/**
 * "Sort by date" on a storage folder (dev job 1f4645b6, 2026-11-04). The database part: read what is in the folder, show a PREVIEW (nothing is
 * written), and on Confirm move the dated items into year / month folders that are REAL folders — so Finder shows exactly what the CRM shows (the
 * Mac change feed is written by triggers on the store tables, no extra step). The rules are in `date-sort-rules.ts` (pure, tested).
 *
 * Safety: a preview and an apply both re-read the folder and re-plan — the screen's list is never trusted. Moves go through the CRM's own
 * `moveFolder` / `moveStoreFile` (same refusals as dragging by hand); the CRM trash is the only undo, which is why Confirm comes after a preview.
 * An apply does at most `batch` (15) moves per call and says how many are left (a 167-folder pile does not fit one request) — the screen repeats the call.
 */
import { supabaseAdmin } from "@/lib/supabase-admin"
import {
  DEFAULT_DATE_SORT, groupKey, groupKeyFromName, orderFolders, parseSettings, planSort,
  type DateSortSettings, type PlanItem, type SortOrder, type SortPlan,
} from "./date-sort-rules"

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- store_* not in generated types until production
const db = () => supabaseAdmin as any
export const APPLY_BATCH = 15
/** Business and My files only for now — a client's folders change what the client sees, so they stay a CRM-by-hand matter. */
const ALLOWED_OWNER_KINDS = ["business", "private"]

interface TargetRow { id: string; owner_id: string; name: string; kind: string; template_slug: string | null; parent_id: string | null; trashed_at: string | null }

async function target(folderId: string): Promise<TargetRow> {
  const { data, error } = await db().from("store_folders").select("id, owner_id, name, kind, template_slug, parent_id, trashed_at").eq("id", folderId).maybeSingle()
  if (error) throw new Error(`Could not read the folder (${error.message}).`)
  if (!data || data.trashed_at) throw new Error("That folder was not found.")
  const { data: o, error: oErr } = await db().from("store_owners").select("kind").eq("id", data.owner_id).maybeSingle()
  if (oErr) throw new Error(`Could not read the storage (${oErr.message}).`)
  if (!o || !ALLOWED_OWNER_KINDS.includes(o.kind)) throw new Error("Sort by date works in Business and My files. A client's folders are changed in the CRM.")
  if (data.template_slug || !data.parent_id || data.kind !== "custom") throw new Error("This is one of the fixed folders — it can't be sorted by date.")
  return data as TargetRow
}

/** The choice saved on the folder (null = none, or the database step for it has not been run yet). */
export async function savedSettings(folderId: string): Promise<DateSortSettings | null> {
  const { data, error } = await db().from("store_folders").select("date_sort").eq("id", folderId).maybeSingle()
  if (error || !data?.date_sort) return null
  const p = parseSettings(data.date_sort)
  return p.ok === true ? (p as { settings: DateSortSettings }).settings : null
}

/**
 * Newest/oldest order for a folder's sub-folders — null when there is none (and never an error: opening a folder must not fail on this).
 * A year / month folder that the sort made has no choice of its own: it follows the nearest folder above it that was sorted (at most 3 levels up).
 */
export async function savedOrder(folderId: string): Promise<SortOrder | null> {
  try {
    let cur: string | null = folderId
    for (let depth = 0; depth < 4 && cur; depth++) {
      const { data, error } = await db().from("store_folders").select("name, parent_id, date_sort").eq("id", cur).maybeSingle()
      if (error || !data) return null
      const p = data.date_sort ? parseSettings(data.date_sort) : null
      if (p && p.ok === true) return (p as { settings: DateSortSettings }).settings.order
      if (groupKeyFromName(data.name) === null) return null          // a hand-made folder with no choice of its own: nothing to inherit
      cur = data.parent_id as string | null
    }
    return null
  } catch { return null }
}

/** Put a folder's sub-folders in its saved order (no saved choice = the list as it came). */
export async function applySavedOrder<T extends { name: string }>(folderId: string, list: T[]): Promise<T[]> {
  const order = await savedOrder(folderId)
  return order ? orderFolders(list, order) : list
}

async function liveChildren(folderId: string): Promise<{ folders: Array<{ id: string; name: string; kind: string; template_slug: string | null; parent_id: string | null }>; files: Array<{ id: string; name: string }> }> {
  const folders: Array<{ id: string; name: string; kind: string; template_slug: string | null; parent_id: string | null }> = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db().from("store_folders").select("id, name, kind, template_slug, parent_id").eq("parent_id", folderId).is("trashed_at", null).order("name").order("id").range(from, from + 999)
    if (error) throw new Error(`Could not read the folder's contents (${error.message}).`)
    folders.push(...((data ?? []) as typeof folders))
    if ((data ?? []).length < 1000) break
  }
  const files: Array<{ id: string; name: string }> = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db().from("store_files").select("id, name").eq("folder_id", folderId).eq("state", "live").order("name").order("id").range(from, from + 999)
    if (error) throw new Error(`Could not read the folder's contents (${error.message}).`)
    files.push(...((data ?? []) as typeof files))
    if ((data ?? []).length < 1000) break
  }
  return { folders, files }
}

const lc = (s: string) => s.trim().toLowerCase()

/** For each group folder the plan would use that ALREADY exists: what it holds (names), keyed by group path. */
async function loadHeld(parentId: string, paths: string[][]): Promise<Map<string, Set<string>>> {
  const held = new Map<string, Set<string>>()
  const idByKey = new Map<string, string>()
  const childrenOf = new Map<string, Awaited<ReturnType<typeof liveChildren>>>()
  const kids = async (id: string) => { const c = childrenOf.get(id) ?? await liveChildren(id); childrenOf.set(id, c); return c }
  for (const path of paths) {
    let cur = parentId
    for (let depth = 1; depth <= path.length; depth++) {
      const key = groupKey(path.slice(0, depth))
      let id: string | undefined = idByKey.get(key)
      if (!id) { id = (await kids(cur)).folders.find((f) => lc(f.name) === lc(path[depth - 1]))?.id; if (id) idByKey.set(key, id) }
      if (!id) break                                            // not there yet — it will be created
      if (!held.has(key)) { const c = await kids(id); held.set(key, new Set([...c.folders.map((f) => lc(f.name)), ...c.files.map((f) => lc(f.name))])) }
      cur = id
    }
  }
  return held
}

async function planFor(folderId: string, s: DateSortSettings): Promise<{ plan: SortPlan; target: TargetRow }> {
  const t = await target(folderId)
  const { folders, files } = await liveChildren(folderId)
  const items: PlanItem[] = [
    ...folders.map((f): PlanItem => ({ id: f.id, kind: "folder", name: f.name, locked: f.template_slug || !f.parent_id ? "a fixed folder" : null })),
    ...files.map((f): PlanItem => ({ id: f.id, kind: "file", name: f.name })),
  ]
  const first = planSort(items, s)
  const paths = Array.from(new Map(first.moves.map((m) => [groupKey(m.path), m.path])).values())
  const held = await loadHeld(folderId, paths)
  return { plan: planSort(items, s, held), target: t }
}

export interface PreviewAnswer {
  folder: string
  settings: DateSortSettings
  total: number
  toMove: number
  stay: number
  clashes: number
  newGroups: string[]
  reusedGroups: string[]
  /** How many items go into each group, in the order the groups will be listed. */
  groups: Array<{ label: string; count: number; example: string }>
  stayList: Array<{ name: string; reason: string }>
  clashList: Array<{ name: string; reason: string }>
}

export async function previewDateSort(folderId: string, settingsInput: unknown): Promise<PreviewAnswer> {
  const p = parseSettings(settingsInput)
  if (p.ok === false) throw new Error((p as { message: string }).message)
  const { plan, target: t } = await planFor(folderId, p.settings)
  const byLabel = new Map<string, { count: number; example: string; sample: { name: string } }>()
  for (const m of plan.moves) {
    const label = m.path.join(" / ")
    const g = byLabel.get(label) ?? { count: 0, example: m.name, sample: { name: label } }
    g.count++
    byLabel.set(label, g)
  }
  const ordered = orderFolders(Array.from(byLabel.entries()).map(([label, g]) => ({ name: label.split(" / ").join(" "), label, ...g })), p.settings.order)
  return {
    folder: t.name, settings: p.settings, total: plan.moves.length + plan.stay.length + plan.clashes.length, toMove: plan.moves.length, stay: plan.stay.length, clashes: plan.clashes.length,
    newGroups: plan.newGroups, reusedGroups: plan.reusedGroups,
    groups: ordered.map((g) => ({ label: g.label, count: g.count, example: g.example })),
    stayList: plan.stay.slice(0, 30).map((x) => ({ name: x.name, reason: x.reason })),
    clashList: plan.clashes.slice(0, 30).map((x) => ({ name: x.name, reason: x.reason })),
  }
}

export interface ApplyAnswer { moved: number; failed: Array<{ name: string; reason: string }>; remaining: number; createdGroups: number }

/** Move up to `batch` of the planned items. Saves the choice on the folder so the list keeps its order and the button remembers it. */
export async function applyDateSort(folderId: string, settingsInput: unknown, actorId: string | null, batch = APPLY_BATCH): Promise<ApplyAnswer> {
  const p = parseSettings(settingsInput)
  if (p.ok === false) throw new Error((p as { message: string }).message)
  const { plan, target: t } = await planFor(folderId, p.settings)
  const { createFolder, moveFolder } = await import("./structure")
  const { moveStoreFile } = await import("./file-actions")
  const { logStoreEvent } = await import("./event-log")
  // remember the choice first (fail-soft: before the database step is run on a database, the sort still works, it just is not remembered)
  const saved = await db().from("store_folders").update({ date_sort: p.settings }).eq("id", folderId)
  const todo = plan.moves.slice(0, Math.max(1, batch))
  const idByKey = new Map<string, string>()
  let createdGroups = 0
  const failed: ApplyAnswer["failed"] = []
  let moved = 0
  const groupFolder = async (path: string[]): Promise<string> => {
    let cur = folderId
    for (let depth = 1; depth <= path.length; depth++) {
      const key = groupKey(path.slice(0, depth))
      const known = idByKey.get(key)
      if (known) { cur = known; continue }
      const { folders } = await liveChildren(cur)
      const hit = folders.find((f) => lc(f.name) === lc(path[depth - 1]))
      if (hit) { idByKey.set(key, hit.id); cur = hit.id; continue }
      const made = await createFolder(cur, path[depth - 1], actorId)
      createdGroups++
      idByKey.set(key, made.id); cur = made.id
    }
    return cur
  }
  for (const m of todo) {
    try {
      const to = await groupFolder(m.path)
      if (m.kind === "folder") await moveFolder(m.id, to, actorId)
      else await moveStoreFile(m.id, to, actorId)
      moved++
    } catch (e) {
      failed.push({ name: m.name, reason: e instanceof Error ? e.message : "could not be moved" })
    }
  }
  await logStoreEvent({ event: "folder_date_sorted", actor: actorId, owner_id: t.owner_id, folder_id: t.id, name_snapshot: t.name, details: { moved, failed: failed.length, groups: createdGroups, settings: p.settings, remembered: !saved.error } })
  return { moved, failed, remaining: Math.max(0, plan.moves.length - todo.length) + failed.length, createdGroups }
}

export { DEFAULT_DATE_SORT }
