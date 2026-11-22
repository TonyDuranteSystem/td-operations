/**
 * Contact merge slice 2 (dev job 938af003): two people who BOTH have their own CRM Storage are COMBINED inside the merge
 * (the database function `merge_contacts` does it, in the same transaction). This file only READS the plan the database would
 * follow — `store_combine_plan` runs the very same code inside a sub-transaction that is always rolled back — and turns it into
 * plain English for the merge window. It never writes.
 */

export interface RenamedFile { file_id: string; folder: string; name: string; new_name: string; same_content: boolean }
export interface MovedFolder { folder: string; new_name: string; files: number }

/** What the database says about a pair of contacts' storages. `combined: false` + `blocker` = cannot be combined; no blocker = nothing to combine. */
export interface CombinePlan {
  combined: boolean
  blocker?: string
  files_moved?: number
  files_renamed?: RenamedFile[]
  folders_merged?: Array<{ folder: string }>
  folders_moved?: MovedFolder[]
  folders_removed?: number
}

export type CombineLookup = (loserId: string, winnerId: string) => Promise<CombinePlan | { error: string }>

const OLD_REFUSAL = "Both contacts already have their own files in the new CRM storage, and this database cannot combine two storages yet. Apply the storage-combine update first, then merge the contacts."

/** Reads the plan from the database. Fails CLOSED: an unreadable answer is an error, never "nothing to combine". */
export async function defaultCombineLookup(loserId: string, winnerId: string): Promise<CombinePlan | { error: string }> {
  const { supabaseAdmin } = await import("@/lib/supabase-admin")
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- store_* functions are not in the generated types until production has them
  const db = supabaseAdmin as any
  const { data, error } = await db.rpc("store_combine_plan", { p_loser_contact: loserId, p_winner_contact: winnerId })
  if (!error) return (data ?? { combined: false }) as CombinePlan
  if (/does not exist|schema cache|could not find the function/i.test(error.message ?? "")) {
    // a database that does not have the combine function yet (production before the update): the old rule — two storages cannot be merged
    const { data: owners, error: oErr } = await db.from("store_owners").select("contact_id").in("contact_id", [loserId, winnerId])
    if (oErr && /does not exist|schema cache/i.test(oErr.message ?? "")) return { combined: false }
    if (oErr) return { error: oErr.message as string }
    const have = new Set(((owners ?? []) as Array<{ contact_id: string }>).map((o) => o.contact_id))
    return have.has(loserId) && have.has(winnerId) ? { combined: false, blocker: OLD_REFUSAL } : { combined: false }
  }
  return { error: error.message as string }
}

export async function getCombinePlan(loserId: string, winnerId: string, lookup: CombineLookup = defaultCombineLookup): Promise<CombinePlan | { error: string }> {
  return lookup(loserId, winnerId)
}

export interface PlanSummary {
  /** one sentence: what happens to the two storages */
  headline: string
  /** the details, one plain sentence each */
  lines: string[]
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
const where = (folder: string) => (folder === "/" || folder === "" ? "the top folder" : folder.replace(/^\//, ""))

/** PURE: the plan in plain English. Null when there is nothing to say (the storages are not combined). */
export function summarizePlan(plan: CombinePlan | null | undefined): PlanSummary | null {
  if (!plan || !plan.combined) return null
  const moved = plan.files_moved ?? 0
  const lines: string[] = []
  const merged = (plan.folders_merged ?? []).map((f) => where(f.folder)).filter((f) => f !== "the top folder")
  if (merged.length > 0) lines.push(`Folders with the same name on both sides are joined: ${merged.join(", ")}.`)
  for (const f of plan.folders_moved ?? []) {
    lines.push(`"${where(f.folder)}" exists only on the removed contact: it moves over as it is (${plural(f.files, "file")}${f.new_name !== where(f.folder).split("/").pop() ? `, renamed "${f.new_name}"` : ""}).`)
  }
  const renamed = plan.files_renamed ?? []
  for (const r of renamed) {
    lines.push(`"${r.name}" in ${where(r.folder)} already exists on the kept contact: both are kept, the incoming one becomes "${r.new_name}"${r.same_content ? " (same content — you can delete one afterwards)" : ""}.`)
  }
  return {
    headline: `The two Storage folders are combined: ${plural(moved, "file")} from the removed contact ${moved === 1 ? "moves" : "move"} into the kept contact's folder. Nothing is overwritten or deleted${renamed.length ? `; ${plural(renamed.length, "file")} ${renamed.length === 1 ? "is" : "are"} renamed because the name was taken` : ""}.`,
    lines,
  }
}
