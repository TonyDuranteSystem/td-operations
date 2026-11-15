/**
 * Address book: reading, creating and changing the TYPES (catalog 'address_book_types'). Antonio makes every type himself; none is built in.
 * Every change goes through the catalog framework helpers, so each one is written to the catalog decision log. A type is never deleted: hiding it (status deprecated)
 * keeps its people, who then show as having no type until it is shown again.
 */
import { supabaseAdmin } from "@/lib/supabase-admin"
import { addEntry, deprecateEntry, getEntryById, listEntries, renameEntry, restoreEntry, updateMetadata, type Actor, type CatalogEntry } from "@/lib/catalog/framework"
import { AddressBookError } from "@/lib/address-book/errors"
import { cleanBoxes, cleanTypeName, typeNameTaken } from "@/lib/address-book/type-input"
import { cleanColor } from "@/lib/address-book/type-colors"
import { ADDRESS_BOOK_TYPES_CATALOG, parseTypeMeta, uniqueBoxKey, type Box } from "@/lib/address-book/types"
import type { TypeDto } from "@/lib/address-book/people"

// the three address book tables are not in lib/database.types.ts yet (regenerate through the CI artifact), so the client is used untyped here, the way lib/marketing does
const db = () => supabaseAdmin as unknown as { from: (t: string) => any }

export function typeDto(e: CatalogEntry, savedCount: number): TypeDto {
  const m = parseTypeMeta(e.metadata)
  return { id: e.id, slug: e.slug, name: e.display_name, color: m.color, sortOrder: m.sort_order, boxes: m.boxes, hidden: e.status !== "active", savedCount }
}

/** How many people are saved under each type id (archived people are not counted). */
export async function savedCounts(): Promise<Map<string, number>> {
  const { data, error } = await db().from("address_book_entries").select("type_entry_id").is("archived_at", null).not("type_entry_id", "is", null)
  if (error) throw new Error(`address book: could not count people per type: ${error.message}`)
  const out = new Map<string, number>()
  for (const r of (data ?? []) as { type_entry_id: string }[]) out.set(r.type_entry_id, (out.get(r.type_entry_id) ?? 0) + 1)
  return out
}

/** Every type, hidden ones included, in the order Antonio keeps them. */
export async function listTypes(): Promise<TypeDto[]> {
  const [entries, counts] = await Promise.all([listEntries(ADDRESS_BOOK_TYPES_CATALOG, { includeDeprecated: true }), savedCounts()])
  return entries.map((e) => typeDto(e, counts.get(e.id) ?? 0)).sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name))
}

const actorOf = (userId: string | null): Actor => ({ kind: "ui", userId })

export interface CreateTypeInput {
  name: unknown
  color?: unknown
  boxes?: unknown
}

export async function createType(input: CreateTypeInput, userId: string | null): Promise<TypeDto> {
  const n = cleanTypeName(input.name)
  if ("error" in n) throw new AddressBookError(400, n.error)
  const existing = await listEntries(ADDRESS_BOOK_TYPES_CATALOG, { includeDeprecated: true })
  if (typeNameTaken(n.name, existing.map((e) => ({ id: e.id, name: e.display_name })))) {
    throw new AddressBookError(409, `There is already a type called "${n.name}". It may be hidden: open Manage types and show it again.`)
  }
  const boxes = cleanBoxes(input.boxes ?? [], [])
  if ("error" in boxes) throw new AddressBookError(400, boxes.error)
  const sortOrder = existing.reduce((max, e) => Math.max(max, parseTypeMeta(e.metadata).sort_order), 0) + 10
  const slug = uniqueBoxKey(n.name, existing.map((e) => e.slug))
  try {
    const entry = await addEntry(
      ADDRESS_BOOK_TYPES_CATALOG,
      { slug, display_name: n.name, metadata: { boxes: boxes.boxes, color: cleanColor(input.color), sort_order: sortOrder, retired_keys: [] } },
      "Address book: new type created in Manage types",
      actorOf(userId),
    )
    return typeDto(entry, 0)
  } catch (e) {
    // the database also refuses two types with the same name; say it in plain words if both of us raced
    if (e instanceof Error && /already exists|uq_catalog_entries_address_book_type_name|duplicate key/i.test(e.message)) {
      throw new AddressBookError(409, `There is already a type called "${n.name}".`)
    }
    throw e
  }
}

export interface UpdateTypeInput {
  name?: unknown
  color?: unknown
  boxes?: unknown
  hidden?: unknown
}

export async function updateType(id: string, patch: UpdateTypeInput, userId: string | null): Promise<TypeDto> {
  const entry = await getEntryById(id)
  if (!entry || entry.catalog_id !== ADDRESS_BOOK_TYPES_CATALOG) throw new AddressBookError(404, "That type was not found. Reload the page.")
  const actor = actorOf(userId)
  let current = entry

  if (patch.name !== undefined) {
    const n = cleanTypeName(patch.name)
    if ("error" in n) throw new AddressBookError(400, n.error)
    if (n.name !== current.display_name) {
      const all = await listEntries(ADDRESS_BOOK_TYPES_CATALOG, { includeDeprecated: true })
      if (typeNameTaken(n.name, all.map((e) => ({ id: e.id, name: e.display_name })), id)) throw new AddressBookError(409, `There is already a type called "${n.name}".`)
      current = await renameEntry(id, n.name, "Address book: type renamed in Manage types", actor)
    }
  }

  if (patch.color !== undefined || patch.boxes !== undefined) {
    const meta = parseTypeMeta(current.metadata)
    const raw = current.metadata && typeof current.metadata === "object" ? (current.metadata as Record<string, unknown>) : {}
    const retiredBefore = Array.isArray(raw.retired_keys) ? (raw.retired_keys as unknown[]).filter((k): k is string => typeof k === "string") : []
    let boxes: Box[] = meta.boxes
    let retired = retiredBefore
    if (patch.boxes !== undefined) {
      const cleaned = cleanBoxes(patch.boxes, meta.boxes, retiredBefore)
      if ("error" in cleaned) throw new AddressBookError(400, cleaned.error)
      boxes = cleaned.boxes
      const kept = new Set(boxes.map((b) => b.key))
      retired = Array.from(new Set([...retiredBefore, ...meta.boxes.filter((b) => !kept.has(b.key)).map((b) => b.key)])).slice(-200)
    }
    const color = patch.color !== undefined ? cleanColor(patch.color) : meta.color
    current = await updateMetadata(id, { ...raw, boxes, color, sort_order: meta.sort_order, retired_keys: retired }, "Address book: type boxes or colour changed in Manage types", actor)
  }

  if (patch.hidden !== undefined) {
    const wantHidden = patch.hidden === true
    const isHidden = current.status !== "active"
    if (wantHidden && !isHidden) current = await deprecateEntry(id, "Address book: type hidden in Manage types", actor)
    else if (!wantHidden && isHidden) current = await restoreEntry(id, "Address book: type shown again in Manage types", actor)
  }

  const counts = await savedCounts()
  return typeDto(current, counts.get(id) ?? 0)
}
