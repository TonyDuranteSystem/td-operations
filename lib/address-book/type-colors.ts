/** Address book: the colours a type may wear. A name only (the page maps it to its own classes); a type with none is plain grey. Pure; client-safe. */
export const TYPE_COLORS = ["zinc", "blue", "green", "amber", "orange", "red", "violet", "pink"] as const
export type TypeColor = (typeof TYPE_COLORS)[number]

export function cleanColor(raw: unknown): TypeColor | null {
  const v = typeof raw === "string" ? raw.trim().toLowerCase() : ""
  return (TYPE_COLORS as readonly string[]).includes(v) ? (v as TypeColor) : null
}
