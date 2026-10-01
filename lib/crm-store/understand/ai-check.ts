/**
 * The AI check inside the storage screen (job 685467b5, Antonio 2026-09-30: "the AI inside the storage, where I can always use it").
 * Server side of: check ONE file, check a company/folder one file at a time, and read the marks the screen shows.
 * Built on the existing File Understanding layer (analyze.ts). It NEVER changes a file: it only records what it found.
 * Safeguards from the 6-reviewer challenge:
 *   · a bulk check leaves personal / ID-like files out (checked only when staff ask for that one file);
 *   · a file version is CLAIMED before it is paid for (judge.claimCall), and the day's cap counts claims in flight;
 *   · marks are derived at read time from the paid facts + the file's current state (mark.ts), never a stored verdict.
 */
import { supabaseAdmin } from "@/lib/supabase-admin"
import { ANALYZER_VERSION, RED_REASON_TEXT } from "./vocab"
import { analyzeVersion, loadTypes } from "./analyze"
import { AiBusyError, AiCapError, AiDisabledError, aiEnabled, dailyCapUsd, spentTodayUsd } from "./judge"
import { deriveMark, isPersonalLike, estimateUsd, type MarkResult } from "./mark"

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- store_* not in generated types until production
const db = () => supabaseAdmin as any

const CHUNK = 200
const chunks = <T,>(list: T[]): T[][] => { const out: T[][] = []; for (let i = 0; i < list.length; i += CHUNK) out.push(list.slice(i, i + CHUNK)); return out }

export type CheckState = "checked" | "skipped_personal" | "cap_reached" | "busy" | "ai_off" | "not_available" | "failed"
export interface CheckOutcome { fileId: string; state: CheckState; message: string | null; analysisId: string | null; mark: MarkResult | null }

interface FileRow { id: string; name: string; owner_id: string; folder_id: string; document_type: string | null; state: string; current_version_id: string | null }

async function typeNames(): Promise<{ name: (slug: string) => string; personal: Set<string> }> {
  const types = await loadTypes()
  const byslug = new Map(types.map((t) => [t.slug, t.displayName]))
  return { name: (slug) => byslug.get(slug) ?? slug, personal: new Set(types.filter((t) => t.personal).map((t) => t.slug)) }
}

/** Is the file a personal / ID-like one (so a bulk run must leave it out)? */
async function personalLike(f: FileRow, personalSlugs: Set<string>): Promise<boolean> {
  const { data: o } = await db().from("store_owners").select("kind").eq("id", f.owner_id).maybeSingle()
  const { effectiveKind } = await import("../structure")
  const folderKind = await effectiveKind(f.folder_id).catch(() => null)
  const { data: v } = f.current_version_id ? await db().from("store_file_versions").select("mime_type").eq("id", f.current_version_id).maybeSingle() : { data: null }
  return isPersonalLike({ documentType: f.document_type, personalSlugs, ownerKind: o?.kind ?? null, folderKind, mime: v?.mime_type ?? null, name: f.name })
}

/** Check ONE file (a click on that file, or one step of a company-wide check). Never changes the file. */
export async function checkOneFile(fileId: string, actor: string | null, opts: { bulk: boolean }): Promise<CheckOutcome> {
  const out = (state: CheckState, message: string | null = null, analysisId: string | null = null, mark: MarkResult | null = null): CheckOutcome => ({ fileId, state, message, analysisId, mark })
  const { data: f } = await db().from("store_files").select("id, name, owner_id, folder_id, document_type, state, current_version_id").eq("id", fileId).maybeSingle()
  const file = f as FileRow | null
  if (!file || file.state !== "live" || !file.current_version_id) return out("not_available", "That file is no longer available.")
  const tn = await typeNames()
  if (opts.bulk && (await personalLike(file, tn.personal))) return out("skipped_personal", "Personal or ID-like — left out of the bulk check. Check it on its own when you need to.")
  try {
    const r = await analyzeVersion(file.current_version_id, { actor, withAi: true })
    const mark = (await marksForFiles([fileId])).get(fileId) ?? null
    return out("checked", null, r.id, mark)
  } catch (e) {
    if (e instanceof AiCapError) return out("cap_reached", "Today's AI budget is used up. It resets at midnight UTC, or ask for a higher daily cap.")
    if (e instanceof AiBusyError) return out("busy", "This file is already being checked.")
    if (e instanceof AiDisabledError) return out("ai_off", "The AI reading is switched off here.")
    return out("failed", e instanceof Error ? e.message : "The file could not be checked.")
  }
}

export interface FileMark extends MarkResult { analysisId: string | null }

/** The marks for a list of files, derived NOW from the analysis of each file's CURRENT version and the file's current type. */
export async function marksForFiles(fileIds: string[]): Promise<Map<string, FileMark>> {
  const result = new Map<string, FileMark>()
  if (!fileIds.length) return result
  const tn = await typeNames()
  for (const part of chunks(fileIds)) {
    const { data: files } = await db().from("store_files").select("id, document_type, current_version_id, state").in("id", part)
    const rows = (files ?? []) as Array<{ id: string; document_type: string | null; current_version_id: string | null; state: string }>
    const versionIds = rows.map((r) => r.current_version_id).filter((x): x is string => !!x)
    const { data: an } = versionIds.length
      ? await db().from("store_file_analysis").select("id, version_id, status, ai_type, ai_injection, owner_named, duplicate_kind, duplicate_of, word_count, problem, updated_at").in("version_id", versionIds).eq("analyzer_version", ANALYZER_VERSION)
      : { data: [] }
    const byVersion = new Map<string, Record<string, any>>((an ?? []).map((a: Record<string, any>) => [a.version_id as string, a]))   // eslint-disable-line @typescript-eslint/no-explicit-any
    const twinIds = Array.from(new Set((an ?? []).map((a: { duplicate_of: string | null }) => a.duplicate_of).filter((x: string | null): x is string => !!x)))
    const liveTwins = new Set<string>()
    if (twinIds.length) {
      const { data: tw } = await db().from("store_files").select("id").in("id", twinIds).eq("state", "live")
      for (const t of (tw ?? []) as { id: string }[]) liveTwins.add(t.id)
    }
    for (const r of rows) {
      const a = r.current_version_id ? byVersion.get(r.current_version_id) ?? null : null
      const m = deriveMark({ analysis: a as never, fileTypeSlug: r.document_type, twinLive: !!a?.duplicate_of && liveTwins.has(a.duplicate_of), typeName: tn.name })
      result.set(r.id, { ...m, analysisId: (a?.id as string | undefined) ?? null })
    }
  }
  return result
}

export interface Checkable { fileIds: string[]; alreadyChecked: number; personalSkipped: number; total: number }

/** The files a company-wide / folder check would read: live, current version not yet checked, personal-like ones left out. */
export async function checkableFiles(scope: { ownerId?: string; folderId?: string }): Promise<Checkable> {
  let all: Array<{ id: string; name: string; folder_id: string }> = []
  if (scope.folderId) {
    const { filesUnder } = await import("../structure")
    all = (await filesUnder(scope.folderId)).map((x) => ({ id: x.id, name: x.name, folder_id: x.folder_id }))
  } else if (scope.ownerId) {
    const { data: root } = await db().from("store_folders").select("id").eq("owner_id", scope.ownerId).is("parent_id", null).eq("kind", "root").is("trashed_at", null).maybeSingle()
    if (root?.id) {
      const { filesUnder } = await import("../structure")
      all = (await filesUnder(root.id)).map((x) => ({ id: x.id, name: x.name, folder_id: x.folder_id }))
    }
  }
  const tn = await typeNames()
  const { data: o } = scope.ownerId ? await db().from("store_owners").select("kind").eq("id", scope.ownerId).maybeSingle() : { data: null }
  const { effectiveKind } = await import("../structure")
  const kindOfFolder = new Map<string, string | null>()
  let alreadyChecked = 0, personalSkipped = 0
  const todo: string[] = []
  for (const part of chunks(all.map((x) => x.id))) {
    const { data: files } = await db().from("store_files").select("id, name, folder_id, document_type, current_version_id, owner_id, state").in("id", part)
    const rows = (files ?? []) as FileRow[]
    const versionIds = rows.map((r) => r.current_version_id).filter((x): x is string => !!x)
    const { data: an } = versionIds.length ? await db().from("store_file_analysis").select("version_id, status, model").in("version_id", versionIds).eq("analyzer_version", ANALYZER_VERSION) : { data: [] }
    const done = new Set<string>((an ?? []).filter((a: { status: string; model: string | null }) => a.status === "unreadable" || !!a.model).map((a: { version_id: string }) => a.version_id))
    const { data: vers } = versionIds.length ? await db().from("store_file_versions").select("id, mime_type").in("id", versionIds) : { data: [] }
    const mime = new Map<string, string | null>((vers ?? []).map((v: { id: string; mime_type: string | null }) => [v.id, v.mime_type]))
    for (const f of rows) {
      if (f.state !== "live" || !f.current_version_id) continue
      if (done.has(f.current_version_id)) { alreadyChecked++; continue }
      if (!kindOfFolder.has(f.folder_id)) kindOfFolder.set(f.folder_id, await effectiveKind(f.folder_id).catch(() => null))
      if (isPersonalLike({ documentType: f.document_type, personalSlugs: tn.personal, ownerKind: o?.kind ?? null, folderKind: kindOfFolder.get(f.folder_id) ?? null, mime: mime.get(f.current_version_id) ?? null, name: f.name })) { personalSkipped++; continue }
      todo.push(f.id)
    }
  }
  return { fileIds: todo, alreadyChecked, personalSkipped, total: all.length }
}

export interface BudgetInfo { aiOn: boolean; spentTodayUsd: number; capUsd: number; leftUsd: number }
export async function budget(): Promise<BudgetInfo> {
  const spent = await spentTodayUsd().catch(() => 0)
  const cap = dailyCapUsd()
  return { aiOn: aiEnabled(), spentTodayUsd: +spent.toFixed(3), capUsd: cap, leftUsd: Math.max(0, +(cap - spent).toFixed(2)) }
}
export { estimateUsd }

/** What the side panel shows for ONE file (paid facts + the current state), in plain words. */
export interface FileReport {
  fileId: string; name: string; folder: string | null; mimeType: string | null
  currentTypeSlug: string | null; currentType: string | null
  mark: FileMark
  aiTypeSlug: string | null; aiType: string | null; aiName: string | null; aiReason: string | null
  identity: boolean; problem: string | null; checkedAt: string | null
  /** could be a passport / ID or sit in a person's own papers — the panel warns before sending it to the AI */
  personalLike: boolean
  twin: { fileId: string; name: string; folder: string | null; mimeType: string | null; kind: string; note: string; differences: Array<{ onlyInA: string[]; onlyInB: string[] }> } | null
  detailTexts: string[]
}

export async function reportForFile(fileId: string): Promise<FileReport | null> {
  const { data: f } = await db().from("store_files").select("id, name, folder_id, document_type, current_version_id, state").eq("id", fileId).maybeSingle()
  if (!f || f.state !== "live") return null
  const tn = await typeNames()
  const mark = (await marksForFiles([fileId])).get(fileId) as FileMark
  const { data: a } = f.current_version_id ? await db().from("store_file_analysis").select("*").eq("version_id", f.current_version_id).eq("analyzer_version", ANALYZER_VERSION).maybeSingle() : { data: null }
  const { data: fo } = await db().from("store_folders").select("name").eq("id", f.folder_id).maybeSingle()
  const { data: v } = f.current_version_id ? await db().from("store_file_versions").select("mime_type").eq("id", f.current_version_id).maybeSingle() : { data: null }
  let twin: FileReport["twin"] = null
  if (a?.duplicate_of) {
    const { data: t } = await db().from("store_files").select("id, name, folder_id, current_version_id").eq("id", a.duplicate_of).eq("state", "live").maybeSingle()
    const { data: tf } = t ? await db().from("store_folders").select("name").eq("id", t.folder_id).maybeSingle() : { data: null }
    const { data: tv } = t?.current_version_id ? await db().from("store_file_versions").select("mime_type").eq("id", t.current_version_id).maybeSingle() : { data: null }
    const d = (a.duplicate_diff ?? {}) as { note?: string; differences?: Array<{ onlyInA: string[]; onlyInB: string[] }> }
    if (t) twin = { fileId: t.id, name: t.name, folder: tf?.name ?? null, mimeType: tv?.mime_type ?? null, kind: a.duplicate_kind ?? "", note: d.note ?? (a.duplicate_kind === "same_bytes" ? "Identical files (every byte)." : ""), differences: (d.differences ?? []).slice(0, 5) }
  }
  const reasons = ((a?.red_reasons ?? []) as string[]).filter((r) => r !== "no_example" && r !== "crm_none")
  const personal = await personalLike({ id: f.id, name: f.name, owner_id: (await db().from("store_files").select("owner_id").eq("id", f.id).maybeSingle()).data?.owner_id, folder_id: f.folder_id, document_type: f.document_type, state: f.state, current_version_id: f.current_version_id }, tn.personal).catch(() => true)
  return {
    fileId: f.id, name: f.name, folder: fo?.name ?? null, mimeType: v?.mime_type ?? null,
    currentTypeSlug: f.document_type, currentType: f.document_type ? tn.name(f.document_type) : null, mark,
    aiTypeSlug: a?.ai_type ?? null, aiType: a?.ai_type ? tn.name(a.ai_type) : null, aiName: a?.ai_name ?? null, aiReason: a?.ai_reason ?? null,
    identity: a?.identity_class === true, problem: a?.problem ?? null, checkedAt: a?.updated_at ?? null, personalLike: personal || a?.identity_class === true, twin,
    detailTexts: reasons.map((r) => RED_REASON_TEXT[r] ?? r),
  }
}
