/**
 * Address book: checks what Antonio types in "Manage types" before it is saved. PURE and client-safe. A type is a name, a colour and a list of boxes (text, date, number, yes/no).
 * The server never trusts a key from the browser: an existing box keeps its key, a new box gets a fresh one made from its label.
 */
import { BOX_KINDS, MAX_BOXES_PER_TYPE, uniqueBoxKey, type Box } from "@/lib/address-book/types"

export const MAX_TYPE_NAME = 60

/** Accents, case and spacing ignored: "Fornitóre " and "fornitore" are the same name. */
export function normalizeTypeName(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
}

/** The name as it will be saved: spacing tidied, never empty, never longer than the limit. Returns an error text instead when it cannot be used. */
export function cleanTypeName(raw: unknown): { name: string } | { error: string } {
  const name = typeof raw === "string" ? raw.replace(/\s+/g, " ").trim() : ""
  if (!name) return { error: "Give the type a name." }
  if (name.length > MAX_TYPE_NAME) return { error: `The name can be at most ${MAX_TYPE_NAME} characters.` }
  return { name }
}

/** True when another type (any status, hidden ones too) already has this name. */
export function typeNameTaken(name: string, others: readonly { id: string; name: string }[], exceptId?: string): boolean {
  const n = normalizeTypeName(name)
  return others.some((o) => o.id !== exceptId && normalizeTypeName(o.name) === n)
}

export interface BoxInput {
  key?: unknown
  label?: unknown
  kind?: unknown
}

/**
 * The boxes a type should have after this save. `existing` are the boxes the type has now (their keys are kept and their kind cannot change, so values already saved stay valid).
 * `retiredKeys` are keys of boxes removed earlier: never given to a new box, so old hidden values cannot show up under a different box.
 */
export function cleanBoxes(raw: unknown, existing: readonly Box[], retiredKeys: readonly string[] = []): { boxes: Box[] } | { error: string } {
  if (!Array.isArray(raw)) return { error: "The boxes were not understood. Reload the page and try again." }
  if (raw.length > MAX_BOXES_PER_TYPE) return { error: `A type can have at most ${MAX_BOXES_PER_TYPE} extra boxes.` }
  const existingByKey = new Map(existing.map((b) => [b.key, b]))
  const used = new Set<string>([...existing.map((b) => b.key), ...retiredKeys])
  const labels = new Set<string>()
  const boxes: Box[] = []
  for (const item of raw as BoxInput[]) {
    const label = typeof item?.label === "string" ? item.label.replace(/\s+/g, " ").trim() : ""
    if (!label) return { error: "Every extra box needs a name." }
    if (label.length > 60) return { error: `The box name "${label.slice(0, 20)}…" is too long (60 characters at most).` }
    const lower = normalizeTypeName(label)
    if (labels.has(lower)) return { error: `Two boxes are both called "${label}".` }
    labels.add(lower)
    const kind = typeof item?.kind === "string" ? item.kind : ""
    if (!(BOX_KINDS as readonly string[]).includes(kind)) return { error: `Choose what goes in "${label}": text, date, number or yes/no.` }
    const key = typeof item?.key === "string" ? item.key : ""
    const known = key ? existingByKey.get(key) : undefined
    if (known) {
      if (known.kind !== kind) return { error: `"${label}" already holds ${known.kind === "yesno" ? "yes/no" : known.kind} values, so its kind cannot change. Remove the box and add a new one.` }
      boxes.push({ key: known.key, label, kind: known.kind })
    } else {
      const fresh = uniqueBoxKey(label, Array.from(used))
      used.add(fresh)
      boxes.push({ key: fresh, label, kind: kind as Box["kind"] })
    }
  }
  return { boxes }
}
