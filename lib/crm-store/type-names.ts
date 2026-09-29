/**
 * Labels the CRM records carry that the NEW store's document types don't know (job 685467b5, 2026-09-29).
 * Nothing is hard-coded: an unknown label becomes a QUESTION in the catalog's existing review queue
 * (catalog_pending_review, catalog "storage_document_types"); the answer is data —
 *   "same as <type>"      → approved_aliased → the label means that type, for every record, now and later
 *   "add as a new type"   → a new catalog type (custom-types) + approved_added
 *   "not a type"          → rejected → records with it are treated as untyped (Set type on the file)
 * The Drive move reads the answers (typeNameAnswers) and queues a label it meets that is used by 2+ records
 * (a one-off label — a file name typed as a type — is fixed on the file with Set type, never asked about).
 */
import { supabaseAdmin } from "@/lib/supabase-admin"

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- store_* not in generated types until production
const db = () => supabaseAdmin as any
const CATALOG = "storage_document_types"
/** a label used by fewer records than this is fixed on the file, not asked about */
export const QUESTION_MIN_RECORDS = 2

export function labelKey(label: string): string {
  return label.replace(/\s+/g, " ").trim().toLowerCase()
}

/** label key → the type slug it was answered with ("same as" or "add as new"). Rejected labels are absent. */
export async function typeNameAnswers(): Promise<Map<string, string>> {
  const { data, error } = await db().from("catalog_pending_review").select("submitted_value, status, catalog_entries!catalog_pending_review_resolved_to_entry_id_fkey(slug, status)")
    .eq("catalog_id", CATALOG).in("status", ["approved_aliased", "approved_added"])
  if (error) throw new Error(`Could not read the answered labels (${error.message}).`)
  const out = new Map<string, string>()
  for (const r of (data ?? []) as { submitted_value: string; catalog_entries: { slug: string; status: string } | null }[]) {
    if (r.catalog_entries?.slug && r.catalog_entries.status === "active") out.set(labelKey(r.submitted_value), r.catalog_entries.slug)
  }
  return out
}

/** Ask about a label (once — an open or answered question for it is never repeated). Only a label 2+ records use. */
export async function queueTypeName(label: string, meta: Record<string, unknown>): Promise<boolean> {
  const clean = label.replace(/\s+/g, " ").trim()
  if (!clean) return false
  const { data: asked, error: aErr } = await db().from("catalog_pending_review").select("id").eq("catalog_id", CATALOG).ilike("submitted_value", clean.replace(/[\\%_]/g, "\\$&")).limit(1)
  if (aErr) throw new Error(`Could not check the questions (${aErr.message}).`)
  if ((asked ?? []).length) return false
  const { count, error: cErr } = await db().from("documents").select("id", { count: "exact", head: true }).ilike("document_type_name", clean.replace(/[\\%_]/g, "\\$&"))
  if (cErr) throw new Error(`Could not count the records (${cErr.message}).`)
  if ((count ?? 0) < QUESTION_MIN_RECORDS) return false
  const { error } = await db().from("catalog_pending_review").insert({ catalog_id: CATALOG, submitted_value: clean, source: "admin_input", source_metadata: { ...meta, records: count }, status: "pending" })
  if (error && !/duplicate key|uq_catalog_pending_open_value/i.test(error.message)) throw new Error(`Could not ask about "${clean}" (${error.message}).`)
  return !error
}

/** "Look for unknown labels": every label 2+ records carry that no type and no question covers yet → a question. */
export async function scanUnknownTypeNames(actorId: string | null): Promise<{ asked: number }> {
  const { data, error } = await db().rpc("store_unknown_document_type_names", { p_min: QUESTION_MIN_RECORDS })
  if (error) throw new Error(`Could not look for unknown labels (${error.message}).`)
  let asked = 0
  for (const r of (data ?? []) as { name: string; records: number }[]) {
    if (await queueTypeName(r.name, { from: "scan", by: actorId })) asked++
  }
  return { asked }
}

export interface TypeQuestion { id: string; label: string; records: number; askedAt: string }

export async function listTypeQuestions(): Promise<TypeQuestion[]> {
  const { data, error } = await db().from("catalog_pending_review").select("id, submitted_value, created_at")
    .eq("catalog_id", CATALOG).eq("status", "pending").order("created_at", { ascending: true })
  if (error) throw new Error(`Could not read the questions (${error.message}).`)
  const rows = (data ?? []) as { id: string; submitted_value: string; created_at: string }[]
  const out: TypeQuestion[] = []
  for (const r of rows) {
    const { count } = await db().from("documents").select("id", { count: "exact", head: true }).ilike("document_type_name", r.submitted_value.replace(/[\\%_]/g, "\\$&"))
    out.push({ id: r.id, label: r.submitted_value, records: count ?? 0, askedAt: r.created_at })
  }
  return out.sort((a, b) => b.records - a.records || a.label.localeCompare(b.label))
}

export type TypeAnswer = { kind: "same"; typeSlug: string } | { kind: "new"; folderKind: string; name?: string } | { kind: "reject" }

export async function answerTypeQuestion(id: string, answer: TypeAnswer, actorId: string | null): Promise<{ typeSlug: string | null }> {
  const { data: q, error } = await db().from("catalog_pending_review").select("id, catalog_id, submitted_value, status").eq("id", id).maybeSingle()
  if (error) throw new Error(`Could not read the question (${error.message}).`)
  if (!q || q.catalog_id !== CATALOG) throw new Error("Question not found.")
  if (q.status !== "pending") throw new Error("This question was already answered.")
  const { getEntry, resolvePendingReview } = await import("@/lib/catalog/framework")
  const actor = { kind: "ui" as const, userId: actorId }
  if (answer.kind === "reject") {
    await resolvePendingReview(id, "rejected", null, `"${q.submitted_value}" is not a document type — records with it are typed one by one`, actor)
    return { typeSlug: null }
  }
  if (answer.kind === "same") {
    const entry = await getEntry(CATALOG, answer.typeSlug)
    if (!entry || entry.status !== "active") throw new Error("That document type is not available.")
    await resolvePendingReview(id, "approved_aliased", entry.id, `"${q.submitted_value}" is another name for "${entry.display_name}"`, actor)
    return { typeSlug: entry.slug }
  }
  const { addCustomDocumentType } = await import("./custom-types")
  const added = await addCustomDocumentType({ name: answer.name?.trim() || q.submitted_value, folderKind: answer.folderKind, actorId })
  const entry = await getEntry(CATALOG, added.slug)
  if (!entry) throw new Error("The new type could not be read back — please try again.")
  await resolvePendingReview(id, added.created ? "approved_added" : "approved_aliased", entry.id, `"${q.submitted_value}" ${added.created ? "added as a new type" : `is the existing type "${entry.display_name}"`}`, actor)
  return { typeSlug: entry.slug }
}
