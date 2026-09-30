/**
 * File Understanding — learning from staff (job 685467b5, Part 15 slice D). Only what a NAMED staff member did
 * counts: a correction (they changed the type) or a one-by-one confirm. An example holds ONLY the type, a name
 * PATTERN and the folder kind — never another client's names, numbers or text. Any example can be retracted, and
 * a retracted example stops counting at once. (AI-written free-text "lessons" are deliberately NOT built yet: they
 * change the prompt for every client; examples first, lessons only if the scoreboard shows they are needed.)
 */
import { supabaseAdmin } from "@/lib/supabase-admin"

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- store_* not in generated types until production
const db = () => supabaseAdmin as any

/** "Form SS-4 - DIECI DIECI COMPANY LLC - Mario Cerbone.pdf" → "form ss-# - # ..." style pattern: no extension, digits → #, owner words dropped. */
export function namePattern(name: string, dropWords: string[] = []): string {
  let n = name.replace(/\.[A-Za-z0-9]{1,5}$/, "").toLowerCase()
  for (const w of dropWords.map((x) => x.toLowerCase().trim()).filter((x) => x.length >= 3)) n = n.split(w).join(" ")
  return n.replace(/\d+/g, "#").replace(/[^a-z#\s-]+/g, " ").replace(/\s+/g, " ").replace(/(\s*-\s*)+$/g, "").trim().slice(0, 60)
}

export interface ExampleRow { id: string; type_slug: string; name_pattern: string | null; folder_kind: string | null }

export async function recordExample(p: { fileId: string; versionId: string | null; typeSlug: string; name: string; folderKind: string | null; dropWords?: string[]; actor: string; origin: "correction" | "confirmed" }): Promise<void> {
  if (!p.actor) throw new Error("Only a named staff member can teach the system.")
  const row = { file_id: p.fileId, version_id: p.versionId, type_slug: p.typeSlug, name_pattern: namePattern(p.name, p.dropWords), folder_kind: p.folderKind, origin: p.origin, created_by: p.actor }
  const { error } = await db().from("store_ai_examples").insert(row)
  if (error && !/store_ai_examples_version_type_uq|duplicate key/i.test(error.message)) throw new Error(`The example could not be saved (${error.message}).`)
}

export async function retractExample(id: string, actor: string): Promise<void> {
  const { error } = await db().from("store_ai_examples").update({ retracted_at: new Date().toISOString(), retracted_by: actor }).eq("id", id).is("retracted_at", null)
  if (error) throw new Error(`The example could not be retracted (${error.message}).`)
}

/** Live examples, newest first, capped — shown to the AI as hints. */
export async function listExamples(limit = 40): Promise<ExampleRow[]> {
  const { data, error } = await db().from("store_ai_examples").select("id, type_slug, name_pattern, folder_kind").is("retracted_at", null).order("created_at", { ascending: false }).limit(limit)
  if (error) throw new Error(`Could not read the examples (${error.message}).`)
  return (data ?? []) as ExampleRow[]
}

/** Does a past staff decision agree with the AI's type for a file shaped like this? pure */
export function exampleCheck(examples: ExampleRow[], aiType: string | null, name: string, folderKind: string | null, dropWords: string[] = []): "pass" | "fail" | "none" {
  if (!aiType) return "none"
  const pat = namePattern(name, dropWords)
  const similar = examples.filter((e) => (pat && e.name_pattern === pat) || (folderKind && e.folder_kind === folderKind && e.name_pattern && pat && (pat.includes(e.name_pattern) || e.name_pattern.includes(pat))))
  if (similar.length === 0) return "none"
  const agree = similar.filter((e) => e.type_slug === aiType).length
  if (agree === 0) return "fail"
  // a correction that points elsewhere outweighs: only pass when the agreeing examples are the majority
  return agree * 2 >= similar.length ? "pass" : "fail"
}

export interface Scoreboard { total: number; acceptedUnchanged: number; changed: number; dismissed: number; examples: number }
export async function scoreboard(): Promise<Scoreboard> {
  const { data } = await db().from("store_ai_decisions").select("action")
  const rows = (data ?? []) as { action: string }[]
  const { count } = await db().from("store_ai_examples").select("id", { count: "exact", head: true }).is("retracted_at", null)
  return { total: rows.length, acceptedUnchanged: rows.filter((r) => r.action === "applied").length, changed: rows.filter((r) => r.action === "changed").length, dismissed: rows.filter((r) => r.action === "dismissed").length, examples: count ?? 0 }
}
