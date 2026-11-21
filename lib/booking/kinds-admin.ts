/**
 * Booking page — adding, renaming, retiring and restoring KINDS of link (Lead, Client, Partner, Private and the ones Antonio adds on the spot).
 * A kind is a row of the catalog `booking_kinds`; every change goes through the catalog framework (which writes the decision log), never a raw update.
 *
 *   - names are compared ignoring capitals, accents and extra spaces, retired kinds included (kindNameTaken), so "Cliënt" cannot sit next to "Client"
 *   - a new kind's rule comes from the two choices drawn on the page: "put the booking on the person's page, or make one if they are new" or "calendar only, no page"
 *   - retiring writes status 'deprecated'; a link already made keeps its own pinned copy of the rule, so nothing sent changes
 */

import { addEntry, deprecateEntry, renameEntry, restoreEntry, type Actor } from "@/lib/catalog/framework"
import { kindNameKey, kindNameTaken, kindOfferedToNewPerson, parseKindRule } from "@/lib/booking/kinds"

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- generic service client
type Db = any

export type NewKindChoice = "record" | "none"

export interface KindDto {
  slug: string
  name: string
  status: "active" | "retired"
  /** false = the kind has no usable rule ("needs setup") and cannot be used for a link */
  ready: boolean
  sortOrder: number
  /** false = not offered when the link is for someone new (Client, People); the maker hides it there and the server refuses it */
  forNewPerson: boolean
}

const MAX_NAME = 40

export function cleanKindName(raw: unknown): string {
  return typeof raw === "string" ? raw.replace(/\s+/g, " ").trim().slice(0, MAX_NAME) : ""
}

/** a lowercase slug from the name; the caller makes it unique */
export function slugFromName(name: string): string {
  const base = kindNameKey(name).replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30)
  return base
}

export function ruleForChoice(choice: NewKindChoice, sortOrder: number): Record<string, unknown> {
  return choice === "none"
    ? { existing_person: "none", new_person: "none", mark_lead: false, sales_template: false, sort_order: sortOrder }
    : { existing_person: "attach", new_person: "lead", mark_lead: true, sales_template: false, sort_order: sortOrder }
}

interface Row {
  id: string
  slug: string
  display_name: string
  status: string
  metadata: unknown
}

async function readAll(db: Db): Promise<{ ok: true; rows: Row[] } | { ok: false }> {
  try {
    const { data, error } = await db.from("catalog_entries").select("id, slug, display_name, status, metadata").eq("catalog_id", "booking_kinds")
    if (error) return { ok: false }
    return { ok: true, rows: (data ?? []) as Row[] }
  } catch {
    return { ok: false }
  }
}

export async function listKinds(db: Db): Promise<{ ok: true; kinds: KindDto[] } | { ok: false; error: string }> {
  const all = await readAll(db)
  if (!all.ok) return { ok: false, error: "The kinds could not be read. Try again." }
  const kinds = all.rows
    .map((r): KindDto => {
      const p = parseKindRule(r.metadata)
      return { slug: r.slug, name: r.display_name, status: r.status === "active" ? "active" : "retired", ready: p.ok, sortOrder: p.ok ? p.sortOrder : 1000, forNewPerson: kindOfferedToNewPerson(r.metadata) }
    })
    .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name))
  return { ok: true, kinds }
}

export type KindResult = { ok: true; kind: KindDto } | { ok: false; status: number; error: string }

const actorOf = (userId: string | null): Actor => ({ kind: "admin_api", userId })

function toDto(row: Row): KindDto {
  const p = parseKindRule(row.metadata)
  return { slug: row.slug, name: row.display_name, status: row.status === "active" ? "active" : "retired", ready: p.ok, sortOrder: p.ok ? p.sortOrder : 1000, forNewPerson: kindOfferedToNewPerson(row.metadata) }
}

export async function addKind(db: Db, input: { name: unknown; choice: unknown }, userId: string | null): Promise<KindResult> {
  const name = cleanKindName(input.name)
  if (!name) return { ok: false, status: 400, error: "Write a name for the new kind, for example Vendor." }
  const choice: NewKindChoice | null = input.choice === "record" || input.choice === "none" ? input.choice : null
  if (!choice) return { ok: false, status: 400, error: "Choose what happens to the booking." }
  const all = await readAll(db)
  if (!all.ok) return { ok: false, status: 500, error: "The kinds could not be read. Try again." }
  if (kindNameTaken(name, all.rows.map((r) => r.display_name))) {
    return { ok: false, status: 409, error: "There is already a kind with that name (a retired one counts too). Pick another name, or restore the old one." }
  }
  const base = slugFromName(name)
  if (!base) return { ok: false, status: 400, error: "Use letters or numbers in the name." }
  const taken = new Set(all.rows.map((r) => r.slug))
  let slug = base
  for (let n = 2; taken.has(slug); n++) slug = `${base}-${n}`
  const sort = Math.max(40, ...all.rows.map((r) => { const p = parseKindRule(r.metadata); return p.ok ? p.sortOrder : 0 })) + 10
  try {
    const entry = await addEntry("booking_kinds", { slug, display_name: name, status: "active", metadata: ruleForChoice(choice, sort) }, "Booking page: a new kind of link added", actorOf(userId))
    return { ok: true, kind: toDto(entry as unknown as Row) }
  } catch (err) {
    return { ok: false, status: /duplicate|unique|23505/i.test(String(err instanceof Error ? err.message : err)) ? 409 : 500, error: "The kind could not be added. Check the name and try again." }
  }
}

export async function changeKind(
  db: Db,
  slug: string,
  change: { rename?: unknown; status?: unknown },
  userId: string | null,
): Promise<KindResult> {
  const all = await readAll(db)
  if (!all.ok) return { ok: false, status: 500, error: "The kinds could not be read. Try again." }
  const row = all.rows.find((r) => r.slug === slug)
  if (!row) return { ok: false, status: 404, error: "That kind could not be found." }
  try {
    let entry: Row = row
    if (change.rename !== undefined) {
      const name = cleanKindName(change.rename)
      if (!name) return { ok: false, status: 400, error: "Write the new name." }
      if (kindNameKey(name) !== kindNameKey(row.display_name) && kindNameTaken(name, all.rows.filter((r) => r.id !== row.id).map((r) => r.display_name))) {
        return { ok: false, status: 409, error: "There is already a kind with that name (a retired one counts too)." }
      }
      entry = (await renameEntry(row.id, name, "Booking page: kind renamed", actorOf(userId))) as unknown as Row
    }
    if (change.status === "retired" && row.status === "active") entry = (await deprecateEntry(row.id, "Booking page: kind retired", actorOf(userId))) as unknown as Row
    else if (change.status === "active" && row.status !== "active") entry = (await restoreEntry(row.id, "Booking page: kind restored", actorOf(userId))) as unknown as Row
    else if (change.status !== undefined && change.status !== "active" && change.status !== "retired") return { ok: false, status: 400, error: "That change is not allowed." }
    return { ok: true, kind: toDto(entry) }
  } catch (err) {
    return { ok: false, status: /duplicate|unique|23505/i.test(String(err instanceof Error ? err.message : err)) ? 409 : 500, error: "The change could not be saved. Try again." }
  }
}
