/**
 * CRM Store — "Check contents" of a finished copy (job 685467b5). Reads every file of the copy through the File
 * Understanding layer (`understand/analyze.ts`): what is INSIDE each file, what the AI thinks it is, whether the
 * CRM/examples agree (green/red), and which files look like the same document. It changes nothing.
 * A person then applies a suggestion with the ordinary Set type / Rename / Remove buttons, and that decision teaches
 * the system (examples). Replaces the fixed word-rule reading (2026-09-30: "the AI can't have a fixed list of rules").
 */
import { supabaseAdmin } from "@/lib/supabase-admin"
import { analyzeVersion } from "./understand/analyze"
import { aiEnabled, spentTodayUsd, dailyCapUsd } from "./understand/judge"
import { RED_REASON_TEXT } from "./understand/vocab"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = () => supabaseAdmin as any

export interface UnderstandRow {
  fileId: string
  analysisId: string | null
  name: string
  folder: string | null
  currentTypeSlug: string | null
  currentType: string | null
  kind: string | null
  status: string
  verdict: "green" | "red" | null
  reasons: string[]
  reasonTexts: string[]
  aiTypeSlug: string | null
  aiType: string | null
  aiName: string | null
  aiReason: string | null
  identity: boolean
  words: number
  problem: string | null
  twin: { fileId: string; name: string; folder: string | null; kind: string; note: string; differences: Array<{ onlyInA: string[]; onlyInB: string[] }> } | null
}
export interface UnderstandReport { runId: string; rows: UnderstandRow[]; unfinished: number; aiOn: boolean; spentTodayUsd: number; capUsd: number }

export async function understandRun(runId: string, actor: string | null, budgetMs = 240_000): Promise<UnderstandReport> {
  const started = Date.now()
  const list: { store_file_id: string; name: string; landed_in: string | null }[] = []
  for (let from = 0; from < 20_000; from += 1000) {                                  // PostgREST returns 1000 rows at most
    const { data: items, error } = await db().from("store_import_items").select("store_file_id, name, landed_in").eq("run_id", runId).in("status", ["done", "merged"]).not("store_file_id", "is", null).order("id").range(from, from + 999)
    if (error) throw new Error(`Could not read the copy (${error.message}).`)
    list.push(...((items ?? []) as typeof list))
    if ((items ?? []).length < 1000) break
  }
  const ids = list.map((i) => i.store_file_id)
  const files: Array<{ id: string; name: string; document_type: string | null; current_version_id: string | null }> = []
  for (let i = 0; i < ids.length; i += 200) {                                       // a long id list would overflow the request address
    const { data } = await db().from("store_files").select("id, name, document_type, current_version_id").in("id", ids.slice(i, i + 200))
    files.push(...((data ?? []) as typeof files))
  }
  const fileOf = new Map<string, { id: string; name: string; document_type: string | null; current_version_id: string | null }>(files.map((f) => [f.id, f]))
  const { data: cat } = await db().from("catalog_entries").select("slug, display_name").eq("catalog_id", "storage_document_types")
  const disp = new Map<string, string>((cat ?? []).map((c: { slug: string; display_name: string }) => [c.slug, c.display_name]))

  let unfinished = 0
  const rows: UnderstandRow[] = []
  for (const it of list) {
    const f = fileOf.get(it.store_file_id)
    if (!f?.current_version_id) { unfinished++; continue }
    if (Date.now() - started > budgetMs) { unfinished++; continue }
    let analysisId: string | null = null
    let problem: string | null = null
    try { analysisId = (await analyzeVersion(f.current_version_id, { actor, withAi: true })).id } catch (e) { problem = e instanceof Error ? e.message : "The file could not be analysed." }
    const { data: a } = analysisId ? await db().from("store_file_analysis").select("*").eq("id", analysisId).maybeSingle() : { data: null }
    let twin: UnderstandRow["twin"] = null
    if (a?.duplicate_of) {
      const { data: t } = await db().from("store_files").select("id, name, folder_id").eq("id", a.duplicate_of).eq("state", "live").maybeSingle()   // a trashed twin is no longer a twin
      const { data: fo } = t ? await db().from("store_folders").select("name").eq("id", t.folder_id).maybeSingle() : { data: null }
      const d = (a.duplicate_diff ?? {}) as { note?: string; differences?: Array<{ onlyInA: string[]; onlyInB: string[] }> }
      if (t) twin = { fileId: t.id, name: t.name, folder: fo?.name ?? null, kind: a.duplicate_kind ?? "", note: d.note ?? (a.duplicate_kind === "same_bytes" ? "Identical files (every byte)." : ""), differences: (d.differences ?? []).slice(0, 5) }
    }
    const reasons = (a?.red_reasons ?? []) as string[]
    rows.push({
      fileId: f.id, analysisId, name: f.name, folder: it.landed_in, currentTypeSlug: f.document_type, currentType: f.document_type ? (disp.get(f.document_type) ?? f.document_type) : null,
      kind: a?.kind ?? null, status: a?.status ?? "failed", verdict: (a?.verdict as "green" | "red" | null) ?? null, reasons, reasonTexts: reasons.map((r) => RED_REASON_TEXT[r] ?? r),
      aiTypeSlug: a?.ai_type ?? null, aiType: a?.ai_type ? (disp.get(a.ai_type) ?? a.ai_type) : null, aiName: a?.ai_name ?? null, aiReason: a?.ai_reason ?? null,
      identity: a?.identity_class === true, words: a?.word_count ?? 0, problem: problem ?? a?.problem ?? null, twin,
    })
  }
  return { runId, rows, unfinished, aiOn: aiEnabled(), spentTodayUsd: await spentTodayUsd().catch(() => 0), capUsd: dailyCapUsd() }
}
