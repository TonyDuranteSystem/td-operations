/**
 * File Understanding — what staff did with a suggestion (job 685467b5). The change itself is made by the ordinary,
 * already-guarded buttons (Set type / Rename / Remove); this only RECORDS it, after checking the file really is in the
 * state the person says — so a decision can never claim something that did not happen — and teaches the system.
 */
import { supabaseAdmin } from "@/lib/supabase-admin"
import { recordExample } from "./examples"
import { ownerWordsOf } from "./analyze"

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- store_* not in generated types until production
const db = () => supabaseAdmin as any

export type DecisionAction = "applied" | "changed" | "dismissed" | "linked" | "moved"

export async function recordDecision(p: { analysisId: string; action: DecisionAction; actor: string }): Promise<{ recorded: string; taught: boolean }> {
  if (!p.actor) throw new Error("Only a named staff member can record a decision.")
  const { data: a, error } = await db().from("store_file_analysis").select("id, file_id, version_id, ai_type, ai_name").eq("id", p.analysisId).maybeSingle()
  if (error || !a) throw new Error("That reading no longer exists.")
  const { data: f } = await db().from("store_files").select("id, name, document_type, folder_id, state, owner_id, current_version_id").eq("id", a.file_id).maybeSingle()
  if (!f || f.state !== "live") throw new Error("The file is no longer available.")
  // a decision belongs to the VERSION that was checked: a newer upload means the answer on screen is about an older file
  if (f.current_version_id && a.version_id !== f.current_version_id) throw new Error("This file was replaced by a newer version since it was checked — check it again.")

  let action: DecisionAction = p.action
  let taught = false
  const teach = async (origin: "correction" | "confirmed") => {
    if (!f.document_type) return
    const { effectiveKind } = await import("../structure")
    const { data: o } = await db().from("store_owners").select("account_id, contact_id").eq("id", f.owner_id).maybeSingle()
    let owner: string | null = null
    if (o?.account_id) owner = (await db().from("accounts").select("company_name").eq("id", o.account_id).maybeSingle()).data?.company_name ?? null
    else if (o?.contact_id) owner = (await db().from("contacts").select("full_name").eq("id", o.contact_id).maybeSingle()).data?.full_name ?? null
    await recordExample({ fileId: f.id, versionId: a.version_id, typeSlug: f.document_type, name: f.name, folderKind: await effectiveKind(f.folder_id).catch(() => null), dropWords: await ownerWordsOf(o?.account_id ?? null, owner), actor: p.actor, origin })
    taught = true
  }
  if (p.action === "applied" || p.action === "changed") {
    // trust the FILE, not the caller: 'applied' only if the file now carries the AI's type; otherwise it is a correction
    if (!f.document_type) throw new Error("The file has no type yet — set its type first.")
    action = f.document_type === a.ai_type ? "applied" : "changed"
    await teach(action === "applied" ? "confirmed" : "correction")
  }
  // a double click must not write the same decision twice
  const { data: dup } = await db().from("store_ai_decisions").select("id").eq("analysis_id", a.id).eq("actor", p.actor).eq("action", action).gte("created_at", new Date(Date.now() - 60_000).toISOString()).limit(1)
  if ((dup ?? []).length > 0) return { recorded: action, taught }
  const { error: dErr } = await db().from("store_ai_decisions").insert({
    analysis_id: a.id, file_id: f.id, action, before_state: { ai_type: a.ai_type, ai_name: a.ai_name }, after_state: { document_type: f.document_type, name: f.name }, actor: p.actor,
  })
  if (dErr) throw new Error(`The decision could not be saved (${dErr.message}).`)
  return { recorded: action, taught }
}
