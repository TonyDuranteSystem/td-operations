/**
 * CRM Store — a person's storage top folder follows the contact's name (Antonio 2026-10-21: "when we change the name in the
 * contact, the folder must also change").
 *
 * The person's folder name lives ONLY as the `store_folders` root row of their owner. `store_rename_root` is idempotent (no change
 * when the name is equal or blank), so this step is safe to call after ANY name change, a contact merge, or at creation. It reads
 * the contact's real name from the database — never a caller's placeholder ("Member", "Client") — and does nothing for a person
 * without a live (non study-only) storage. Best-effort by contract: it never throws.
 */

import { supabaseAdmin } from "@/lib/supabase-admin"
import { storeSafeFolderName } from "./formation-pilot"

// Placeholder spellings a caller may pass when it has no name; a contact whose stored name is one of these is NOT renamed to it.
const PLACEHOLDER_NAMES = new Set(["client", "member", "person", "new client", "company", "file"])

/** PURE: the folder name this contact should have, or null when the name must not be used (blank / a placeholder). */
export function personRootNameFor(fullName: string | null | undefined): string | null {
  const cleaned = storeSafeFolderName(fullName ?? "")
  if (!fullName || !fullName.trim()) return null
  if (PLACEHOLDER_NAMES.has(cleaned.toLowerCase())) return null
  return cleaned
}

export type SyncPersonRootResult =
  | { status: "renamed"; ownerId: string; name: string }
  | { status: "unchanged"; ownerId: string }
  | { status: "skipped"; reason: "no_contact" | "no_name" | "no_storage" }
  | { status: "failed"; error: string }

export async function syncPersonRootName(contactId: string): Promise<SyncPersonRootResult> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the store_* tables/functions are not in the generated types
    const db = supabaseAdmin as any
    const { data: c, error: cErr } = await db.from("contacts").select("full_name").eq("id", contactId).maybeSingle()
    if (cErr) return { status: "failed", error: cErr.message }
    if (!c) return { status: "skipped", reason: "no_contact" }
    const name = personRootNameFor(c.full_name as string | null)
    if (!name) return { status: "skipped", reason: "no_name" }
    const { data: owner, error: oErr } = await db.from("store_owners").select("id").eq("contact_id", contactId).eq("kind", "person").eq("study_only", false).limit(1)
    if (oErr) return { status: "failed", error: oErr.message }
    const ownerId = (owner ?? [])[0]?.id as string | undefined
    if (!ownerId) return { status: "skipped", reason: "no_storage" }
    const { data: renamed, error } = await db.rpc("store_rename_root", { p_owner_id: ownerId, p_name: name, p_actor: null })
    if (error) return { status: "failed", error: error.message }
    return renamed === true ? { status: "renamed", ownerId, name } : { status: "unchanged", ownerId }
  } catch (e) {
    return { status: "failed", error: e instanceof Error ? e.message : String(e) }
  }
}

export interface RootNameMismatch { ownerId: string; contactId: string; folderName: string; shouldBe: string }

/** PURE: the owners whose top folder differs from what their contact's name says. */
export function findRootMismatches(
  owners: Array<{ id: string; contact_id: string }>,
  rootNameOf: Map<string, string>,
  fullNameOf: Map<string, string | null>,
): RootNameMismatch[] {
  const out: RootNameMismatch[] = []
  for (const o of owners) {
    const shouldBe = personRootNameFor(fullNameOf.get(o.contact_id))
    const folderName = rootNameOf.get(o.id)
    if (!shouldBe || folderName === undefined || folderName === shouldBe) continue
    out.push({ ownerId: o.id, contactId: o.contact_id, folderName, shouldBe })
  }
  return out
}

/** Every live person storage whose top folder does not carry the contact's name; apply=true renames them (each through the same step as a name edit). */
export async function sweepPersonRootNames(apply: boolean): Promise<{ checked: number; mismatches: RootNameMismatch[]; renamed: number; failed: string[] }> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the store_* tables are not in the generated types
  const db = supabaseAdmin as any
  const owners: Array<{ id: string; contact_id: string }> = []
  for (let page = 0; page < 50; page++) {
    const { data, error } = await db.from("store_owners").select("id, contact_id").eq("kind", "person").eq("study_only", false).not("contact_id", "is", null).order("id").range(page * 500, page * 500 + 499)
    if (error) throw new Error(`sweep: could not read the storages — ${error.message}`)
    owners.push(...(data ?? []))
    if (!data || data.length < 500) break
  }
  const rootNameOf = new Map<string, string>()
  const fullNameOf = new Map<string, string | null>()
  for (let i = 0; i < owners.length; i += 100) {
    const chunk = owners.slice(i, i + 100)
    const { data: roots, error: rErr } = await db.from("store_folders").select("owner_id, name").in("owner_id", chunk.map((o) => o.id)).is("parent_id", null).is("trashed_at", null)
    if (rErr) throw new Error(`sweep: could not read the folders — ${rErr.message}`)
    for (const r of roots ?? []) rootNameOf.set(r.owner_id as string, r.name as string)
    const { data: cs, error: cErr } = await db.from("contacts").select("id, full_name").in("id", chunk.map((o) => o.contact_id))
    if (cErr) throw new Error(`sweep: could not read the contacts — ${cErr.message}`)
    for (const c of cs ?? []) fullNameOf.set(c.id as string, (c.full_name as string | null) ?? null)
  }
  const mismatches = findRootMismatches(owners, rootNameOf, fullNameOf)
  let renamed = 0
  const failed: string[] = []
  if (apply) {
    for (const m of mismatches) {
      const r = await syncPersonRootName(m.contactId)
      if (r.status === "renamed") renamed++
      else failed.push(`${m.contactId}: ${r.status}`)
    }
  }
  return { checked: owners.length, mismatches, renamed, failed }
}
