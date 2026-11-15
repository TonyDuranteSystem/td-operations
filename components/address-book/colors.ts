import type { CrmKind } from "@/lib/address-book/crm-kind"
import type { TypeColor } from "@/lib/address-book/type-colors"

/** Address book — the classes each colour name wears (written out in full so the style sheet keeps them). */
export const PILL: Record<TypeColor, string> = {
  zinc: "bg-zinc-100 text-zinc-700",
  blue: "bg-blue-50 text-blue-700",
  green: "bg-green-50 text-green-700",
  amber: "bg-amber-50 text-amber-800",
  orange: "bg-orange-50 text-orange-700",
  red: "bg-red-50 text-red-700",
  violet: "bg-violet-50 text-violet-700",
  pink: "bg-pink-50 text-pink-700",
}

export const SWATCH: Record<TypeColor, string> = {
  zinc: "bg-zinc-400",
  blue: "bg-blue-500",
  green: "bg-green-500",
  amber: "bg-amber-500",
  orange: "bg-orange-500",
  red: "bg-red-500",
  violet: "bg-violet-500",
  pink: "bg-pink-500",
}

/** The colour of what the CRM calls a person. */
export const CRM_PILL: Record<CrmKind, string> = {
  company: PILL.blue,
  individual: PILL.violet,
  lead: PILL.amber,
  past: PILL.zinc,
  partner: PILL.green,
  banker: PILL.green,
  other: PILL.zinc,
  unsorted: "border border-dashed border-amber-400 bg-amber-50 text-amber-800",
}

export function pillFor(color: string | null | undefined): string {
  return (color && (PILL as Record<string, string>)[color]) || PILL.zinc
}
