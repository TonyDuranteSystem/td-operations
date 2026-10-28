/**
 * SS-4 "Resubmit" — the correction flow for an SS-4 that was already signed / faxed and then turned out
 * wrong (dev job 25e460aa; origin: the IRS rejected Tanto per LLC's SS-4 because Line 6 was copied from a
 * Wyoming registered agent).
 *
 * What it does, in this order:
 *   1. Runs EVERY check a brand-new SS-4 needs (prepareSS4: state, signer, registered agent IN THE COMPANY'S STATE,
 *      county for Line 6, mailing address) — a failure here returns the reason and touches NOTHING.
 *   2. Moves the old SS-4 into ss4_applications_archive and inserts the corrected draft in ONE database step
 *      (resubmit_ss4) — all or nothing. The archive keeps the signed row whole (signature data, timestamps,
 *      signed-PDF pointer) plus why / who / when and a link to the replacement.
 *   3. Retires the old SS-4's flow-document rows so the new SS-4's documents are unambiguous.
 *   4. Gives the new draft the same set-up as any new SS-4 (finishSS4Create).
 *
 * It never sends anything to the client, never moves the service-delivery stage, and never touches the
 * client portal. The corrected SS-4 starts as a DRAFT: staff look at the preview, then use the normal
 * "Send to Client for Signature" step.
 *
 * Because the old row leaves ss4_applications, that table still holds at most one SS-4 per company — every
 * existing lookup keeps working untouched.
 */

import { supabaseAdmin } from "@/lib/supabase-admin"
import { logAction } from "@/lib/mcp/action-log"
import { APP_BASE_URL } from "@/lib/config"
import { prepareSS4, finishSS4Create, type CreateSS4Outcome } from "@/lib/operations/ss4"

/** Statuses that mean "the client already signed / it was filed" — the only ones a resubmit is for. */
export const RESUBMITTABLE_STATUSES = ["signed", "submitted", "done", "fax_failed"] as const

/** Flow-document types that belong to one specific SS-4 (the old one's become "… (Replaced)"). */
const SS4_DOC_TYPES = ["SS-4", "Form SS-4 (Unsigned)", "Form SS-4 (Signed)", "SS-4 + Articles (IRS Package)"] as const
export const REPLACED_SUFFIX = " (Replaced)"

export type ResubmitOutcome =
  | "resubmitted"
  | "reason_required"
  | "no_ss4"
  | "not_resubmittable"
  | CreateSS4Outcome

export interface ResubmitResult {
  ok: boolean
  outcome: ResubmitOutcome
  message: string
  old?: { id: string; token: string; status: string; county_and_state: string | null }
  ss4?: { id: string; token: string; access_code: string; status: string; county_and_state: string | null }
  previewUrl?: string
  /** Things that did not block the resubmit but staff should look at. */
  warnings?: string[]
}

export const MIN_REASON_LENGTH = 3

/** The token for the corrected SS-4: the normal token plus -r<n>, so it can never clash with the archived one. */
export function resubmitToken(baseToken: string, archivedCount: number, taken: ReadonlySet<string>): string {
  let n = archivedCount + 1
  let candidate = `${baseToken}-r${n}`
  while (taken.has(candidate)) {
    n += 1
    candidate = `${baseToken}-r${n}`
  }
  return candidate
}

export async function resubmitSs4(args: { account_id: string; reason: string; by: string; source: string }): Promise<ResubmitResult> {
  const { account_id, by, source } = args
  const reason = (args.reason ?? "").trim()
  if (reason.length < MIN_REASON_LENGTH) {
    return { ok: false, outcome: "reason_required", message: "A reason is required (for example: wrong registered agent address)." }
  }

  try {
    // ─── 1. the SS-4 being replaced ───
    const { data: old, error: oldErr } = await supabaseAdmin
      .from("ss4_applications")
      .select("id, token, status, contact_id, county_and_state, company_name")
      .eq("account_id", account_id)
      .maybeSingle()
    if (oldErr) return { ok: false, outcome: "error", message: `Could not load the SS-4: ${oldErr.message}. Nothing was changed.` }
    if (!old) return { ok: false, outcome: "no_ss4", message: "This company has no SS-4 yet — use Generate SS-4." }
    if (!(RESUBMITTABLE_STATUSES as readonly string[]).includes(old.status)) {
      return {
        ok: false,
        outcome: "not_resubmittable",
        message: `The SS-4 is still "${old.status}" — it has not been signed yet. Use "Regenerate from account data" to correct it instead.`,
        old: { id: old.id, token: old.token, status: old.status, county_and_state: old.county_and_state },
      }
    }

    // ─── 2. every check a new SS-4 needs, BEFORE anything is touched ───
    // The same responsible party signs the corrected SS-4 (the IRS has that person on file); only the data is refreshed.
    const prep = await prepareSS4(
      { account_id, contact_id: old.contact_id ?? undefined },
      { allowExisting: true },
    )
    if (!prep.prepared) {
      return { ok: false, outcome: prep.outcome, message: `${prep.message ?? "The corrected SS-4 could not be prepared."} Nothing was archived — the current SS-4 is unchanged.` }
    }

    // ─── 3. a token that cannot clash with the archived one ───
    const { count: archivedCount } = await (supabaseAdmin as any) // eslint-disable-line @typescript-eslint/no-explicit-any -- new table, not in generated types
      .from("ss4_applications_archive")
      .select("id", { count: "exact", head: true })
      .eq("account_id", account_id)
    const base = String(prep.prepared.row.token)
    const { data: liveTokens } = await supabaseAdmin.from("ss4_applications").select("token").like("token", `${base}-r%`)
    const token = resubmitToken(base, archivedCount ?? 0, new Set((liveTokens ?? []).map((t) => t.token as string)))
    const newRow: Record<string, unknown> = { ...prep.prepared.row, token }

    // ─── 4. archive the old one + insert the new one, atomically ───
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: newId, error: rpcErr } = await (supabaseAdmin as any).rpc("resubmit_ss4", {
      p_old_id: old.id,
      p_reason: reason,
      p_by: by,
      p_new: newRow,
    })
    if (rpcErr || !newId) {
      return {
        ok: false,
        outcome: "error",
        message: `The SS-4 could not be resubmitted: ${rpcErr?.message || "no id returned"}. Nothing was changed — the previous SS-4 is intact.`,
      }
    }

    const warnings: string[] = []

    // ─── 5. retire the old SS-4's flow-document rows ───
    const retired = await retireOldSs4Documents(account_id, old.token)
    if (retired.error) warnings.push(retired.error)
    if (retired.ids.length) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (supabaseAdmin as any).from("ss4_applications_archive").update({ retired_document_ids: retired.ids }).eq("id", old.id)
    }

    // ─── 6. the corrected SS-4 gets the same set-up as any new one (draft: nothing is sent to the client) ───
    const finished = await finishSS4Create(prep.prepared, {
      id: newId as string,
      token,
      access_code: String(prep.prepared.row.access_code),
      status: String(prep.prepared.row.status),
    })

    // ─── 7. trail ───
    logAction({
      actor: by,
      action_type: "resubmit",
      table_name: "ss4_applications",
      record_id: newId as string,
      account_id,
      summary: `SS-4 resubmitted for ${prep.prepared.company_name}: ${reason}`,
      details: {
        source,
        reason,
        archived_ss4_id: old.id,
        archived_token: old.token,
        archived_status: old.status,
        old_line6: old.county_and_state,
        new_line6: newRow.county_and_state ?? null,
        retired_document_ids: retired.ids,
      },
    })
    await noteStageHistory(account_id, `SS-4 resubmitted (${reason}); the previous SS-4 was archived. A corrected draft is ready for review.`)

    return {
      ok: true,
      outcome: "resubmitted",
      message:
        `The old SS-4 was archived and a corrected draft was created. Line 6 changed from ` +
        `"${old.county_and_state ?? "(blank)"}" to "${(newRow.county_and_state as string | null) ?? "(blank)"}". ` +
        `Check the preview, then send it to the client for signature. Nothing has been sent to the client.`,
      old: { id: old.id, token: old.token, status: old.status, county_and_state: old.county_and_state },
      ss4: {
        id: newId as string,
        token,
        access_code: String(newRow.access_code),
        status: String(newRow.status),
        county_and_state: (newRow.county_and_state as string | null) ?? null,
      },
      previewUrl: finished.previewUrl ?? `${APP_BASE_URL}/ss4/${token}/${String(newRow.access_code)}?preview=td`,
      ...(warnings.length ? { warnings } : {}),
    }
  } catch (e) {
    return { ok: false, outcome: "error", message: `The SS-4 could not be resubmitted: ${e instanceof Error ? e.message : String(e)}` }
  }
}

/**
 * The old SS-4's flow-document rows: the "live" shortcut row (it renders from the old token, which no longer exists) is removed;
 * the stored copies (unsigned / signed / IRS package) stay as history but are relabelled "(Replaced)" so no lookup by type can
 * mistake them for the corrected SS-4's files. The fax confirmation and everything else is untouched.
 */
async function retireOldSs4Documents(accountId: string, oldToken: string): Promise<{ ids: string[]; error?: string }> {
  const ids: string[] = []
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- document_type_name not in generated types
    const { data: docs, error } = await (supabaseAdmin as any)
      .from("documents")
      .select("id, file_name, document_type_name, drive_file_id")
      .eq("account_id", accountId)
      .in("document_type_name", [...SS4_DOC_TYPES])
    if (error) return { ids, error: `The old SS-4's documents could not be relabelled: ${error.message}` }
    const stamp = new Date().toISOString().slice(0, 10)
    for (const d of (docs ?? []) as Array<{ id: string; file_name: string | null; document_type_name: string; drive_file_id: string | null }>) {
      if (d.document_type_name === "SS-4" && (d.drive_file_id ?? "").startsWith("ss4-live:")) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { error: delErr } = await (supabaseAdmin as any).from("documents").delete().eq("id", d.id).eq("drive_file_id", `ss4-live:${oldToken}`)
        if (delErr) return { ids, error: `The old SS-4's live document row could not be removed: ${delErr.message}` }
        ids.push(d.id)
        continue
      }
      const name = (d.file_name ?? "SS-4.pdf").replace(/\.pdf$/i, "") + ` (replaced ${stamp}).pdf`
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { error: updErr } = await (supabaseAdmin as any)
        .from("documents")
        .update({ document_type_name: d.document_type_name + REPLACED_SUFFIX, file_name: name })
        .eq("id", d.id)
      if (updErr) return { ids, error: `An old SS-4 document could not be relabelled: ${updErr.message}` }
      ids.push(d.id)
    }
    return { ids }
  } catch (e) {
    return { ids, error: `The old SS-4's documents could not be relabelled: ${e instanceof Error ? e.message : String(e)}` }
  }
}

/** A line in the active Company Formation delivery's history. Never moves the stage. Best-effort. */
async function noteStageHistory(accountId: string, note: string): Promise<void> {
  try {
    const { data: sd } = await supabaseAdmin
      .from("service_deliveries")
      .select("id, stage_history")
      .eq("account_id", accountId)
      .eq("service_type", "Company Formation")
      .eq("status", "active")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle()
    if (!sd) return
    const history = Array.isArray(sd.stage_history) ? sd.stage_history : []
    history.push({ event: "ss4_resubmitted", at: new Date().toISOString(), note })
    // eslint-disable-next-line no-restricted-syntax -- stage_history note only; the stage itself is not touched
    await supabaseAdmin.from("service_deliveries").update({ stage_history: history, updated_at: new Date().toISOString() }).eq("id", sd.id)
  } catch {
    /* best-effort */
  }
}
