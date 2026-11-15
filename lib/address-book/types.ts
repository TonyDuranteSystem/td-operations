/**
 * Address book: types, the boxes of a type, and the small clean-ups used before anything is saved. Pure; client-safe.
 * A TYPE is a catalog row (catalog_id 'address_book_types'); its boxes live in that row's metadata. Nothing here names a type: Antonio creates them.
 * Box kinds are deliberately few (text, date, number, yes/no) and have no rules between them.
 */
import { z } from "zod"

export const ADDRESS_BOOK_TYPES_CATALOG = "address_book_types"

export const BOX_KINDS = ["text", "date", "number", "yesno"] as const
export type BoxKind = (typeof BOX_KINDS)[number]

export const MAX_BOXES_PER_TYPE = 20
const BOX_KEY = /^[a-z][a-z0-9_]{0,39}$/

export const boxSchema = z.object({
  key: z.string().regex(BOX_KEY),
  label: z.string().trim().min(1).max(60),
  kind: z.enum(BOX_KINDS),
})
export type Box = z.infer<typeof boxSchema>

export interface TypeMeta {
  boxes: Box[]
  color: string | null
  sort_order: number
}

/** Reads a type's metadata without ever throwing: a bad box is dropped, a repeated key keeps the first, more than the limit are cut. */
export function parseTypeMeta(meta: unknown): TypeMeta {
  const m = meta && typeof meta === "object" ? (meta as Record<string, unknown>) : {}
  const boxes: Box[] = []
  const seen = new Set<string>()
  if (Array.isArray(m.boxes)) {
    for (const raw of m.boxes) {
      const p = boxSchema.safeParse(raw)
      if (!p.success || seen.has(p.data.key)) continue
      seen.add(p.data.key)
      boxes.push(p.data)
      if (boxes.length >= MAX_BOXES_PER_TYPE) break
    }
  }
  const color = typeof m.color === "string" && m.color.trim() ? m.color.trim().slice(0, 20) : null
  const sort_order = typeof m.sort_order === "number" && Number.isFinite(m.sort_order) ? m.sort_order : 0
  return { boxes, color, sort_order }
}

/** "What they supply us" -> "what_they_supply_us". Accents are dropped. Always returns a valid key. */
export function boxKeyFromLabel(label: string): string {
  const base = label
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
  const k = /^[a-z]/.test(base) ? base : `box_${base}`
  return k.replace(/_+$/g, "").slice(0, 40) || "box"
}

/** A key for a new box that is not already used by the type: what_they_supply_us, what_they_supply_us_2, ... */
export function uniqueBoxKey(label: string, existing: readonly string[]): string {
  const base = boxKeyFromLabel(label)
  if (!existing.includes(base)) return base
  for (let i = 2; i < 100; i++) {
    const k = `${base.slice(0, 36)}_${i}`
    if (!existing.includes(k)) return k
  }
  return `${base.slice(0, 30)}_${Date.now() % 100000}`
}

export type ExtraValue = string | number | boolean
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

/**
 * Checks the values typed into a type's boxes. Only boxes the type really has are kept; an empty value is dropped; a value of the wrong kind is reported, not saved.
 * Returns the cleaned values and what was wrong (empty = fine).
 */
export function cleanExtra(boxes: readonly Box[], extra: unknown): { value: Record<string, ExtraValue>; problems: string[] } {
  const src = extra && typeof extra === "object" ? (extra as Record<string, unknown>) : {}
  const value: Record<string, ExtraValue> = {}
  const problems: string[] = []
  for (const box of boxes) {
    const raw = src[box.key]
    if (raw === undefined || raw === null || raw === "") continue
    if (box.kind === "text") {
      const t = String(raw).trim()
      if (t) value[box.key] = t.slice(0, 500)
    } else if (box.kind === "number") {
      const n = typeof raw === "number" ? raw : Number(String(raw).trim().replace(",", "."))
      if (Number.isFinite(n)) value[box.key] = n
      else problems.push(`${box.label} must be a number`)
    } else if (box.kind === "date") {
      const d = String(raw).trim()
      const ok = ISO_DATE.test(d) && !Number.isNaN(Date.parse(`${d}T00:00:00Z`)) && new Date(`${d}T00:00:00Z`).toISOString().startsWith(d)
      if (ok) value[box.key] = d
      else problems.push(`${box.label} must be a date`)
    } else if (box.kind === "yesno") {
      if (typeof raw === "boolean") value[box.key] = raw
      else if (raw === "yes" || raw === "true") value[box.key] = true
      else if (raw === "no" || raw === "false") value[box.key] = false
      else problems.push(`${box.label} must be yes or no`)
    }
  }
  return { value, problems }
}

/** Digits only, used to find "already saved" by phone. Under 5 digits is not a number worth matching. */
export function phoneKey(phone: string | null | undefined): string | null {
  const d = (phone ?? "").replace(/\D+/g, "")
  return d.length >= 5 ? d : null
}

export function normalizeEmail(email: string | null | undefined): string | null {
  const e = (email ?? "").trim().toLowerCase()
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e : null
}

const optText = (max: number) => z.string().trim().max(max).optional().nullable().transform((v) => (v ? v : null))

/** What may be typed for a person (Company or Personal book). The type and the extra boxes are checked separately against the type. */
export const personInputSchema = z.object({
  full_name: z.string().trim().min(1).max(200),
  company: optText(200),
  job_title: optText(200),
  website: optText(300),
  phones: z.array(z.string().trim().min(1).max(60)).max(6).default([]),
  emails: z.array(z.string().trim().min(1).max(200)).max(6).default([]),
  address: optText(500),
  notes: optText(4000),
  type_entry_id: z.string().uuid().nullable().optional(),
  extra: z.record(z.string(), z.unknown()).optional(),
})
export type PersonInput = z.infer<typeof personInputSchema>

/** The searchable keys written next to a person: lower-case emails, digits-only phones, with repeats removed. */
export function lookupKeys(p: { phones?: readonly string[]; emails?: readonly string[] }): { phones: string[]; phone_keys: string[]; emails: string[] } {
  const phones = (p.phones ?? []).map((x) => x.trim()).filter(Boolean)
  const phone_keys = Array.from(new Set(phones.map(phoneKey).filter((k): k is string => !!k)))
  const emails = Array.from(new Set((p.emails ?? []).map(normalizeEmail).filter((e): e is string => !!e)))
  return { phones, phone_keys, emails }
}
