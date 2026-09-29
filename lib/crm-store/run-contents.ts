/**
 * CRM Store — "Check contents" of a finished copy (job 685467b5, Antonio 2026-09-30). READ-ONLY.
 *
 * Reads what is inside every file the copy stored, says what the system thinks each one is next to the type it
 * got from the old CRM record, and lists file pairs that might be the same document — byte-identical copies,
 * or same-named files whose WORDS are compared one by one. It changes nothing: no retype, rename or delete.
 * A person looks at the answer; only then do rules get made.
 */
import { supabaseAdmin } from "@/lib/supabase-admin"
import { readStoreFileContent, type ContentReading } from "./read-content"
import { compareTexts, type TextDifference } from "./content-compare"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = () => supabaseAdmin as any

export interface ContentFileRow {
  fileId: string
  name: string
  folder: string | null
  currentType: string | null
  suggestedType: string | null
  suggestionStrength: "high" | "medium" | "low" | null
  /** "agree" | "differ" (both typed, not the same) | "new" (untyped, system has a guess) | "unknown" (nothing to say) */
  verdict: "agree" | "differ" | "new" | "unknown"
  converted: boolean
  pageCount: number
  words: number
  /** the first words found — so a person can see what the system saw */
  snippet: string
  problem: string | null
}

export interface DuplicatePair {
  a: { fileId: string; name: string; folder: string | null }
  b: { fileId: string; name: string; folder: string | null }
  /** identical bytes / identical words (bytes differ) / words differ */
  kind: "same_bytes" | "same_words" | "different_words" | "not_compared"
  differences: TextDifference[]
  tooDifferentToList: boolean
  note: string
}

export interface ContentReport { runId: string; files: ContentFileRow[]; pairs: DuplicatePair[]; unread: number; budgetHit: boolean }

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "")

export async function checkRunContents(runId: string, budgetMs = 240_000): Promise<ContentReport> {
  const started = Date.now()
  const { data: items, error } = await db().from("store_import_items")
    .select("store_file_id, name, sha256, landed_in, status").eq("run_id", runId).in("status", ["done", "merged"]).not("store_file_id", "is", null)
  if (error) throw new Error(`Could not read the copy (${error.message}).`)
  const rows = (items ?? []) as { store_file_id: string; name: string; sha256: string | null; landed_in: string | null }[]
  const ids = rows.map((r) => r.store_file_id)
  const { data: files } = ids.length ? await db().from("store_files").select("id, document_type").in("id", ids) : { data: [] }
  const typeOf = new Map<string, string | null>((files ?? []).map((f: { id: string; document_type: string | null }) => [f.id, f.document_type]))
  const { data: cat } = await db().from("catalog_entries").select("slug, display_name").eq("catalog_id", "storage_document_types")
  const nameOfType = new Map<string, string>((cat ?? []).map((c: { slug: string; display_name: string }) => [c.slug, c.display_name]))

  const readings = new Map<string, ContentReading>()
  let budgetHit = false
  for (const r of rows) {
    if (Date.now() - started > budgetMs) { budgetHit = true; break }
    readings.set(r.store_file_id, await readStoreFileContent(r.store_file_id))
  }

  const out: ContentFileRow[] = rows.map((r) => {
    const rd = readings.get(r.store_file_id)
    const slug = typeOf.get(r.store_file_id) ?? null
    const currentType = slug ? (nameOfType.get(slug) ?? slug) : null
    const suggested = rd?.suggestedType ?? null
    const verdict: ContentFileRow["verdict"] = !suggested ? "unknown" : !currentType ? "new" : norm(currentType) === norm(suggested) ? "agree" : "differ"
    const text = rd?.text ?? ""
    return {
      fileId: r.store_file_id, name: r.name, folder: r.landed_in, currentType, suggestedType: suggested,
      suggestionStrength: rd?.suggestionStrength ?? null, verdict, converted: !!rd?.converted, pageCount: rd?.pageCount ?? 0,
      words: text.split(/\s+/).filter(Boolean).length, snippet: text.replace(/\s+/g, " ").slice(0, 160),
      problem: rd ? rd.problem : "Not read yet (time ran out) — press Check contents again.",
    }
  })

  const pairs: DuplicatePair[] = []
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      const x = rows[i]; const y = rows[j]
      const sameBytes = !!x.sha256 && x.sha256 === y.sha256
      const sameName = norm(x.name) === norm(y.name)
      if (!sameBytes && !sameName) continue
      const side = (r: typeof x) => ({ fileId: r.store_file_id, name: r.name, folder: r.landed_in })
      if (sameBytes) { pairs.push({ a: side(x), b: side(y), kind: "same_bytes", differences: [], tooDifferentToList: false, note: "Identical files (every byte)." }); continue }
      const ta = readings.get(x.store_file_id)?.text; const tb = readings.get(y.store_file_id)?.text
      if (!ta?.trim() || !tb?.trim()) { pairs.push({ a: side(x), b: side(y), kind: "not_compared", differences: [], tooDifferentToList: false, note: "Same name; the words of one or both could not be read, so they were not compared." }); continue }
      const c = compareTexts(ta, tb)
      pairs.push({
        a: side(x), b: side(y), kind: c.identical ? "same_words" : "different_words", differences: c.differences, tooDifferentToList: c.tooDifferentToList,
        note: c.identical ? "Every word is the same." : c.tooDifferentToList ? "The words differ a lot — not the same document." : `${c.differences.length} place(s) where the words differ.`,
      })
    }
  }
  return { runId, files: out, pairs, unread: out.filter((f) => f.problem).length, budgetHit }
}
