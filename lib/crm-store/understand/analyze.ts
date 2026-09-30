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
import { maskIds, textNamesOwner } from "./privacy"

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
  /** words that belong to the owner (company + members) — dropped from name patterns so no client's name is ever stored as an example */
  ownerWords: string[]
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
  const ownerWords = await ownerWordsOf(o?.account_id ?? null, ownerName)
  return { version: v, file: f, owner: o ?? { kind: "unknown", account_id: null, contact_id: null }, ownerName, ownerWords, folderKind }
}

/** The owner's own words: the company/person name and, for a company, its members' names. */
export async function ownerWordsOf(accountId: string | null, ownerName: string | null): Promise<string[]> {
  const words = ownerName ? [ownerName] : []
  if (accountId) {
    const { data: links } = await db().from("account_contacts").select("contacts(full_name)").eq("account_id", accountId).limit(20)
    for (const l of (links ?? []) as Array<{ contacts: { full_name: string | null } | null }>) if (l.contacts?.full_name) words.push(l.contacts.full_name)
  }
  return words
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
  // (a re-saved copy under another name). A look-alike found only by size must really match to be reported.
  const rows: Array<{ id: string; name: string; store_file_versions: Ctx["version"] }> = []
  for (let from = 0; from < 2000; from += 500) {
    const { data } = await db().from("store_files")
      .select("id, name, store_file_versions!store_files_current_version_fk!inner(id, size_bytes, storage_bucket, storage_path)")
      .eq("state", "live").eq("owner_id", ctx.file.owner_id).neq("id", ctx.file.id).order("id").range(from, from + 499)
    rows.push(...((data ?? []) as typeof rows))
    if ((data ?? []).length < 500) break
  }
  const mine = key(ctx.file.name)
  const words = e.text.split(/\s+/).filter(Boolean).length
  const byName = rows.filter((f) => key(f.name) === mine)
  let byWords: typeof rows = []
  if (words >= 20) {
    const tol = Math.max(5, Math.floor(words * 0.01))
    const nearIds = new Set<string>()
    for (let i = 0; i < rows.length; i += 200) {
      const { data: near } = await db().from("store_file_analysis").select("file_id")
        .in("file_id", rows.slice(i, i + 200).map((r) => r.id)).gte("word_count", words - tol).lte("word_count", words + tol)
      for (const n of (near ?? []) as { file_id: string }[]) nearIds.add(n.file_id)
    }
    byWords = rows.filter((f) => nearIds.has(f.id) && !byName.some((b) => b.id === f.id))
  }
  const cand = [...byName.map((c) => ({ c, strict: true })), ...byWords.map((c) => ({ c, strict: false }))].slice(0, 3)
  for (const { c, strict } of cand) {
    try {
      if (c.store_file_versions.size_bytes > LIMITS.maxFileBytes) continue
      const other = await extractContent(await downloadVersion(c.store_file_versions), c.name)
      const a = assessPair(e.text, other.text)
      if (!strict && a.verdict !== "same_words" && a.verdict !== "minor_marks") continue
      return { verdict: a.verdict, twin: c.id, diff: { note: a.note, differences: a.differences.slice(0, 10), material: a.materialDifferences.slice(0, 10) } }
    } catch (err) {
      console.error("[understand] a possible twin could not be compared:", err instanceof Error ? err.message : err)   // one broken twin never blocks the file
    }
  }
  return { verdict: null, twin: null, diff: null }
}

/** The twin, if it is still a live file (a trashed twin is no longer a twin). */
async function liveTwin(id: string | null): Promise<string | null> {
  if (!id) return null
  const { data } = await db().from("store_files").select("state").eq("id", id).maybeSingle()
  return data?.state === "live" ? id : null
}

/** Only mark-free words of a differing pair are kept, and never any ID number — and NONE for an ID-class file. */
function safeDiff(diff: unknown, identity: boolean): unknown {
  if (!diff || identity) return diff ? { note: (diff as { note?: string }).note ?? "", differences: [], material: [] } : null
  const d = diff as { note?: string; differences?: Array<{ at: number; onlyInA: string[]; onlyInB: string[] }>; material?: string[] }
  return { note: d.note, material: (d.material ?? []).map(maskIds), differences: (d.differences ?? []).map((x) => ({ at: x.at, onlyInA: x.onlyInA.map(maskIds), onlyInB: x.onlyInB.map(maskIds) })) }
}

export interface AnalysisResult { id: string; status: string; verdict: string | null; redReasons: string[]; aiType: string | null; aiName: string | null; reused: boolean }

const asResult = (r: { id: string; status: string; verdict: string | null; red_reasons: string[] | null; ai_type: string | null; ai_name: string | null }, reused: boolean): AnalysisResult =>
  ({ id: r.id, status: r.status, verdict: r.verdict, redReasons: r.red_reasons ?? [], aiType: r.ai_type, aiName: r.ai_name, reused })

/** Personal / ID-class = its type says so, by ANY source (the AI, the file's own type, or its CRM record). */
function isIdentityType(types: TypeChoice[], ...slugs: Array<string | null | undefined>): boolean {
  return slugs.some((sl) => !!sl && types.find((t) => t.slug === sl)?.personal === true)
}

/**
 * Re-decide an ALREADY judged file WITHOUT reading or paying again: the paid answers (what the AI said) are kept; the
 * proofs that can change with a person's work — the CRM/file type, the examples, whether the twin still exists — are
 * recomputed, so a green can appear after "Use this type" and a removed twin stops being offered.
 */
async function refreshProofs(ex: Record<string, any>, types: TypeChoice[]): Promise<AnalysisResult> {   // eslint-disable-line @typescript-eslint/no-explicit-any
  const ctx = await loadCtx(ex.version_id)
  const crmSlug = await crmSlugOf(ctx, types)
  const crm: "pass" | "fail" | "none" = !ex.ai_type || !crmSlug ? "none" : ex.ai_type === crmSlug ? "pass" : "fail"
  const example = exampleCheck(await listExamples(200), ex.ai_type ?? null, ctx.file.name, ctx.folderKind, ctx.ownerWords)
  const twinId = await liveTwin(ex.duplicate_of)
  const dupKind = twinId ? ex.duplicate_kind : null
  const v = computeVerdict({
    read: { ok: ex.status !== "unreadable", partial: ex.pages_read != null && ex.page_count != null && ex.pages_read < ex.page_count, hasWords: (ex.word_count ?? 0) > 0 },
    ai: { typeSlug: ex.ai_type, injection: ex.ai_injection === true, nameRejected: ex.ai_name_rejected === true, failed: false },
    crm, example, ownerMismatch: ex.owner_named === false, duplicate: dupKind,
  })
  const { data: upd } = await db().from("store_file_analysis").update({
    verdict: v.verdict, red_reasons: v.reasons, crm_check: crm, example_check: example, duplicate_of: twinId, duplicate_kind: dupKind,
    duplicate_diff: twinId ? ex.duplicate_diff : null, updated_at: new Date().toISOString(),
  }).eq("id", ex.id).select("id, status, verdict, red_reasons, ai_type, ai_name").single()
  return asResult(upd ?? { id: ex.id, status: ex.status, verdict: v.verdict, red_reasons: v.reasons, ai_type: ex.ai_type, ai_name: ex.ai_name }, true)
}

export async function analyzeVersion(versionId: string, opts: { actor?: string | null; withAi?: boolean } = {}): Promise<AnalysisResult> {
  const withAi = opts.withAi !== false
  const types = await loadTypes()
  const { data: existing } = await db().from("store_file_analysis").select("*").eq("version_id", versionId).eq("analyzer_version", ANALYZER_VERSION).maybeSingle()
  if (existing?.status === "unreadable") return asResult(existing, true)                               // a final state
  if (existing?.model) return refreshProofs(existing, types)                                            // the AI already answered: never pay twice
  if (existing && !withAi && existing.status !== "failed") return asResult(existing, true)              // read-only ask, already read

  const ctx = await loadCtx(versionId)
  if (ctx.file.state !== "live") throw new Error("The file is in the trash.")
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
  const example = exampleCheck(await listExamples(200), ai?.typeSlug ?? null, ctx.file.name, ctx.folderKind, ctx.ownerWords)
  const twin = readRow.status === "unreadable" ? { verdict: null, twin: null, diff: null } : await twinOf(ctx, e, opts.actor ?? null)
  // wrong-client proof: the document must NAME the storage's owner (the AI is not trusted to volunteer a company name)
  const named = readRow.status === "unreadable" ? null : textNamesOwner(e.text, ctx.ownerName, ai?.companyName)
  const injection = !!ai && (ai.injectionSuspected || looksLikeInjection(e.text))
  const v = computeVerdict({
    read: { ok: readRow.status !== "unreadable", partial: e.partial, hasWords: words > 0 },
    ai: aiFailed || !ai ? null : { typeSlug: ai.typeSlug, injection, nameRejected: ai.nameRejected, failed: false },
    crm, example, ownerMismatch: named === false, duplicate: twin.verdict,
  })
  const isIdentity = isIdentityType(types, ai?.typeSlug, ctx.file.document_type, crmSlug)

  const { data: fin } = await db().from("store_file_analysis").update({
    // a file the AI could not judge stays a plain 'read' row, so the next run tries the AI again
    status: readRow.status === "unreadable" ? "unreadable" : ai ? "judged" : readRow.status,
    identity_class: isIdentity, ai_type: ai?.typeSlug ?? null, ai_name: ai?.suggestedName ?? null, ai_reason: ai ? maskIds(ai.reason) : null, ai_company: ai?.companyName ?? null, ai_year: ai?.year ?? null,
    ai_injection: ai ? injection : null, ai_name_rejected: ai ? ai.nameRejected : null, owner_named: named,
    verdict: v.verdict, red_reasons: v.reasons, crm_check: crm, example_check: example, duplicate_of: twin.twin, duplicate_kind: twin.verdict, duplicate_diff: safeDiff(twin.diff, isIdentity),
    model: ai?.usage.model ?? null, input_tokens: ai?.usage.input ?? null, output_tokens: ai?.usage.output ?? null, updated_at: new Date().toISOString(),
  }).eq("id", analysisId).select("id, status, verdict, red_reasons, ai_type, ai_name").single()

  // the words go into the SEARCHABLE text only when the AI (or the file's own type) says it is NOT personal/ID — and never for
  // a picture whose type is unknown; a personal file's text stays out of search
  const knownNotPersonal = !isIdentity && (!!ai?.typeSlug || !!ctx.file.document_type)
  if (knownNotPersonal && readRow.status !== "unreadable" && words > 0) await db().from("store_file_versions").update({ ocr_text: e.text.slice(0, 500_000) }).eq("id", versionId).is("ocr_text", null)
  if (ai?.typeSlug) {
    const { count } = await db().from("store_file_facts").select("id", { count: "exact", head: true }).eq("version_id", versionId).eq("key", "ai_type")
    if (!count) await db().from("store_file_facts").insert({ file_id: ctx.file.id, version_id: versionId, key: "ai_type", value: ai.typeSlug, source: "ai" })
  }
  return asResult(fin ?? { id: analysisId, status: "judged", verdict: v.verdict, red_reasons: v.reasons, ai_type: ai?.typeSlug ?? null, ai_name: ai?.suggestedName ?? null }, false)
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
