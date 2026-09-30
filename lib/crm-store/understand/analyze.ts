/**
 * File Understanding — read a stored file version, ask the AI, check the CRM, decide green/red (job 685467b5).
 * ONE row per (version, analyzer version) in store_file_analysis: a second run of the same job finds the row and does
 * not spend again. Nothing here changes a file: it never retypes, renames, moves or deletes — it only records what it
 * found. A person applies a suggestion (routes under /api/crm-store/understand).
 */
import { supabaseAdmin } from "@/lib/supabase-admin"
import { ANALYZER_VERSION, LIMITS } from "./vocab"
import { extractContent, type Extracted } from "./extract"
import { assessPair, normHash, type PairVerdict } from "./duplicates"
import { computeVerdict } from "./verdict"
import { classifyFile, AiDisabledError, AiCapError, looksLikeInjection, type TypeChoice, type ClassifyOutput } from "./judge"
import { listExamples, exampleCheck } from "./examples"

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- store_* not in generated types until production
const db = () => supabaseAdmin as any

export function analysisEnabled(): boolean { return process.env.STORE_ANALYSIS_ENABLED === "1" }

export async function loadTypes(): Promise<TypeChoice[]> {
  const { data, error } = await db().from("catalog_entries").select("slug, display_name, description, metadata, status").eq("catalog_id", "storage_document_types").eq("status", "active")
  if (error) throw new Error(`Could not read the document types (${error.message}).`)
  return ((data ?? []) as { slug: string; display_name: string; description: string | null; metadata: { personal?: boolean } | null }[])
    .map((t) => ({ slug: t.slug, displayName: t.display_name, description: t.description, personal: t.metadata?.personal === true }))
}

const key = (s: string | null | undefined) => (s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "")

interface Ctx {
  version: { id: string; file_id: string; size_bytes: number; storage_bucket: string; storage_path: string; sha256: string }
  file: { id: string; name: string; owner_id: string; folder_id: string; document_type: string | null; state: string }
  owner: { kind: string; account_id: string | null; contact_id: string | null }
  ownerName: string | null
  folderKind: string | null
}

async function loadCtx(versionId: string): Promise<Ctx> {
  const { data: v, error } = await db().from("store_file_versions").select("id, file_id, size_bytes, storage_bucket, storage_path, sha256").eq("id", versionId).maybeSingle()
  if (error || !v) throw new Error(error ? `Could not read the version (${error.message}).` : "Version not found.")
  const { data: f } = await db().from("store_files").select("id, name, owner_id, folder_id, document_type, state").eq("id", v.file_id).maybeSingle()
  if (!f) throw new Error("File not found.")
  const { data: o } = await db().from("store_owners").select("kind, account_id, contact_id").eq("id", f.owner_id).maybeSingle()
  let ownerName: string | null = null
  if (o?.account_id) ownerName = (await db().from("accounts").select("company_name").eq("id", o.account_id).maybeSingle()).data?.company_name ?? null
  else if (o?.contact_id) ownerName = (await db().from("contacts").select("full_name").eq("id", o.contact_id).maybeSingle()).data?.full_name ?? null
  const { effectiveKind } = await import("../structure")
  const folderKind = await effectiveKind(f.folder_id).catch(() => null)
  return { version: v, file: f, owner: o ?? { kind: "unknown", account_id: null, contact_id: null }, ownerName, folderKind }
}

async function downloadVersion(v: Ctx["version"]): Promise<Buffer> {
  const { data, error } = await db().storage.from(v.storage_bucket).download(v.storage_path)
  if (error || !data) throw new Error("The stored file could not be downloaded.")
  return Buffer.from(await data.arrayBuffer())
}

async function readOf(ctx: Ctx): Promise<{ e: Extracted; bytes: Buffer | null }> {
  if (ctx.version.size_bytes > LIMITS.maxFileBytes) {
    return { bytes: null, e: { kind: "unknown", mime: "application/octet-stream", text: "", pages: [], pageCount: null, pagesRead: 0, partial: false, visual: null, converted: false, problem: `The file is too large to read (${Math.round(ctx.version.size_bytes / 1048576)} MB).`, terminal: true } }
  }
  const bytes = await downloadVersion(ctx.version)
  return { bytes, e: await extractContent(bytes, ctx.file.name) }
}

/** The type the CRM/import already gave this file, as a slug: the store file's own type, else its CRM record's label. */
async function crmSlugOf(ctx: Ctx, types: TypeChoice[]): Promise<string | null> {
  if (ctx.file.document_type) return ctx.file.document_type
  const { storePointer } = await import("../document-pointer")
  const { data } = await db().from("documents").select("document_type_name").eq("drive_file_id", storePointer(ctx.file.id)).limit(1).maybeSingle()
  const label = key(data?.document_type_name)
  return label ? (types.find((t) => key(t.displayName) === label)?.slug ?? null) : null
}

/** Same-named or byte-identical files of the SAME owner, compared; other owners' twins become links, never actions. */
async function twinOf(ctx: Ctx, e: Extracted, actor: string | null): Promise<{ verdict: PairVerdict | null; twin: string | null; diff: unknown }> {
  const { data: same } = await db().from("store_files")
    .select("id, name, owner_id, store_file_versions!store_files_current_version_fk!inner(id, sha256, size_bytes, storage_bucket, storage_path)")
    .eq("state", "live").neq("id", ctx.file.id).eq("store_file_versions.sha256", ctx.version.sha256).limit(20)
  for (const o of (same ?? []) as Array<{ id: string; owner_id: string }>) {
    if (o.owner_id !== ctx.file.owner_id && actor) {
      await db().from("store_file_links").upsert({ file_id: ctx.file.id, other_file_id: o.id, kind: "same_bytes", note: "Identical bytes in another storage — linked, not merged.", created_by: actor }, { onConflict: "file_id,other_file_id", ignoreDuplicates: true })
    }
  }
  const sameOwnerBytes = ((same ?? []) as Array<{ id: string; owner_id: string }>).find((o) => o.owner_id === ctx.file.owner_id)
  if (sameOwnerBytes) return { verdict: "same_bytes", twin: sameOwnerBytes.id, diff: null }
  // candidates: same-named files, plus files of the same owner whose reading has almost exactly as many words
  // (a re-saved copy with another name). A look-alike found only by size must really match to be reported.
  const { data: named } = await db().from("store_files")
    .select("id, name, store_file_versions!store_files_current_version_fk!inner(id, size_bytes, storage_bucket, storage_path)")
    .eq("state", "live").eq("owner_id", ctx.file.owner_id).neq("id", ctx.file.id).limit(200)
  const mine = key(ctx.file.name)
  const rows = (named ?? []) as Array<{ id: string; name: string; store_file_versions: Ctx["version"] }>
  const words = e.text.split(/\s+/).filter(Boolean).length
  const byName = rows.filter((f) => key(f.name) === mine)
  let byWords: typeof rows = []
  if (words >= 20) {
    const tol = Math.max(5, Math.floor(words * 0.01))
    const { data: near } = await db().from("store_file_analysis").select("file_id, version_id, word_count")
      .in("file_id", rows.map((r) => r.id)).gte("word_count", words - tol).lte("word_count", words + tol)
    const nearIds = new Set(((near ?? []) as { file_id: string }[]).map((n) => n.file_id))
    byWords = rows.filter((f) => nearIds.has(f.id) && !byName.some((b) => b.id === f.id))
  }
  const cand = [...byName.map((c) => ({ c, strict: true })), ...byWords.map((c) => ({ c, strict: false }))].slice(0, 4)
  for (const { c, strict } of cand) {
    if (c.store_file_versions.size_bytes > LIMITS.maxFileBytes) continue
    const other = await extractContent(await downloadVersion(c.store_file_versions), c.name)
    const a = assessPair(e.text, other.text)
    if (!strict && a.verdict !== "same_words" && a.verdict !== "minor_marks") continue
    return { verdict: a.verdict, twin: c.id, diff: { note: a.note, differences: a.differences.slice(0, 10), material: a.materialDifferences.slice(0, 10) } }
  }
  return { verdict: null, twin: null, diff: null }
}

export interface AnalysisResult { id: string; status: string; verdict: string | null; redReasons: string[]; aiType: string | null; aiName: string | null; reused: boolean }

export async function analyzeVersion(versionId: string, opts: { actor?: string | null; withAi?: boolean } = {}): Promise<AnalysisResult> {
  const withAi = opts.withAi !== false
  const { data: existing } = await db().from("store_file_analysis").select("*").eq("version_id", versionId).eq("analyzer_version", ANALYZER_VERSION).maybeSingle()
  if (existing && (existing.status === "judged" || existing.status === "unreadable" || (!withAi && existing.status === "read"))) {
    return { id: existing.id, status: existing.status, verdict: existing.verdict, redReasons: existing.red_reasons ?? [], aiType: existing.ai_type, aiName: existing.ai_name, reused: true }
  }
  const ctx = await loadCtx(versionId)
  if (ctx.file.state !== "live") throw new Error("The file is in the trash.")
  const types = await loadTypes()
  const { e } = await readOf(ctx)
  const words = e.text.split(/\s+/).filter(Boolean).length
  const readRow = {
    version_id: versionId, file_id: ctx.file.id, analyzer_version: ANALYZER_VERSION, kind: e.kind, page_count: e.pageCount, pages_read: e.pagesRead, word_count: words,
    norm_sha256: words ? normHash(e.text) : null, problem: e.problem, status: e.terminal && !e.text.trim() ? "unreadable" : e.partial ? "partial" : "read", updated_at: new Date().toISOString(),
  }
  const { data: row, error: upErr } = await db().from("store_file_analysis").upsert(readRow, { onConflict: "version_id,analyzer_version" }).select("id").single()
  if (upErr) throw new Error(`The reading could not be saved (${upErr.message}).`)
  const analysisId = row.id as string
  if (!withAi && readRow.status !== "unreadable") return { id: analysisId, status: readRow.status, verdict: null, redReasons: [], aiType: null, aiName: null, reused: false }

  // ── the AI's turn (skipped for a file that could not be read at all)
  let ai: ClassifyOutput | null = null
  let aiFailed = false
  if (readRow.status !== "unreadable") {
    try {
      const examples = await listExamples(40)
      ai = await classifyFile({
        name: ctx.file.name, pages: e.pages.length ? e.pages : [e.text], folderKind: ctx.folderKind, ownerLabel: ctx.ownerName, types,
        examples: examples.map((x) => ({ typeSlug: x.type_slug, namePattern: x.name_pattern, folderKind: x.folder_kind })), visual: e.visual,
      }, { analysisId, versionId })
    } catch (err) {
      aiFailed = true
      if (!(err instanceof AiDisabledError) && !(err instanceof AiCapError)) console.error("[understand] AI call failed:", err instanceof Error ? err.message : err)
    }
  }

  // ── the proofs
  const crmSlug = await crmSlugOf(ctx, types)
  const crm: "pass" | "fail" | "none" = !ai?.typeSlug || !crmSlug ? "none" : ai.typeSlug === crmSlug ? "pass" : "fail"
  const dropWords = [ctx.ownerName ?? ""]
  const example = exampleCheck(await listExamples(200), ai?.typeSlug ?? null, ctx.file.name, ctx.folderKind, dropWords)
  const twin = readRow.status === "unreadable" ? { verdict: null, twin: null, diff: null } : await twinOf(ctx, e, opts.actor ?? null)
  const ownerMismatch = !!(ai?.companyName && ctx.owner.account_id && ctx.ownerName && !key(ctx.ownerName).includes(key(ai.companyName)) && !key(ai.companyName).includes(key(ctx.ownerName)))
  const nameRejected = !!ai?.nameRejected
  const v = computeVerdict({
    read: { ok: readRow.status !== "unreadable", partial: e.partial, hasWords: words > 0 },
    ai: aiFailed ? null : ai ? { typeSlug: ai.typeSlug, injection: ai.injectionSuspected || looksLikeInjection(e.text), nameRejected, failed: false } : null,
    crm, example, ownerMismatch, duplicate: twin.verdict === "same_bytes" ? "same_bytes" : twin.verdict,
  })
  const isIdentity = !!ai?.typeSlug && types.find((t) => t.slug === ai!.typeSlug)?.personal === true || (!!ctx.file.document_type && types.find((t) => t.slug === ctx.file.document_type)?.personal === true)

  await db().from("store_file_analysis").update({
    status: readRow.status === "unreadable" ? "unreadable" : "judged",
    identity_class: isIdentity, ai_type: ai?.typeSlug ?? null, ai_name: ai?.suggestedName ?? null, ai_reason: ai?.reason ?? null, ai_company: ai?.companyName ?? null, ai_year: ai?.year ?? null,
    verdict: v.verdict, red_reasons: v.reasons, crm_check: crm, example_check: example, duplicate_of: twin.twin, duplicate_kind: twin.verdict, duplicate_diff: twin.diff,
    model: ai?.usage.model ?? null, input_tokens: ai?.usage.input ?? null, output_tokens: ai?.usage.output ?? null, updated_at: new Date().toISOString(),
  }).eq("id", analysisId)

  // the words go into the searchable text ONLY for a non-personal file whose text is real (a passport's text stays out of search)
  const searchable = !isIdentity && readRow.status !== "unreadable" && words > 0 && !(e.visual && !ai?.typeSlug)
  if (searchable) await db().from("store_file_versions").update({ ocr_text: e.text.slice(0, 500_000) }).eq("id", versionId).is("ocr_text", null)
  if (ai?.typeSlug) await db().from("store_file_facts").insert({ file_id: ctx.file.id, version_id: versionId, key: "ai_type", value: ai.typeSlug, source: "ai" })

  return { id: analysisId, status: readRow.status === "unreadable" ? "unreadable" : "judged", verdict: v.verdict, redReasons: v.reasons, aiType: ai?.typeSlug ?? null, aiName: ai?.suggestedName ?? null, reused: false }
}

/** Queue a background analysis for a version (default OFF). One job per version; a second call while one waits does nothing. */
export async function enqueueAnalysis(versionId: string, actor: string | null): Promise<boolean> {
  if (!analysisEnabled()) return false
  const { data: pending } = await db().from("job_queue").select("id, payload").eq("job_type", "store_file_analyze").in("status", ["pending", "processing"]).limit(500)
  if (((pending ?? []) as { payload: { version_id?: string } }[]).some((j) => j.payload?.version_id === versionId)) return false
  const { enqueueJob } = await import("@/lib/jobs/queue")
  await enqueueJob({ job_type: "store_file_analyze", payload: { version_id: versionId, actor }, max_attempts: 1 } as never)
  return true
}
