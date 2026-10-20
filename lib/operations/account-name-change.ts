/**
 * Change Name (Track S3): a company's legal name changes ONLY through the Change Name path, so the old name is remembered
 * (accounts.previous_name + the append-only accounts.name_history) and the storage folders are archived — in ONE database
 * call (store_apply_name_change_for_account, scripts/migrations/20261019-1500-store-apply-name-change.sql).
 *
 * This module is the one place that
 *   - decides whether an edit is a real name change or only a fix of capital letters / spacing (the database makes the same call);
 *   - refuses a real name change on the generic edit paths (the CRM inline edit, the crm_update_record tool, updateAccount,
 *     the client-audit sheet) with one plain message — and refuses any hand write of previous_name / name_history;
 *   - calls the two database functions and turns their refusals into plain messages.
 * Track B wires the Change Name service to applyAccountNameChange.
 */
import { supabaseAdmin } from "@/lib/supabase-admin"

// the store_* / name-change functions are not in the generated types until they reach production
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = () => supabaseAdmin as any

export const NAME_CHANGE_MESSAGE =
  "A company's legal name can't be changed here. Use the Change Name service on the company's page, so the old name is kept and the storage folders are archived. (Fixing only capital letters or spacing is fine.)"
export const NAME_HISTORY_MESSAGE = "The previous name and the name history are written only by the Change Name service — they can't be edited by hand."

/** The comparison the database makes: capital letters, runs of spaces and edge spaces do not make a different name. */
export function nameKey(name: string): string {
  return name.normalize("NFC").replace(/\s+/g, " ").trim().toLowerCase()
}

/** True when `next` is a genuinely different name (not just capitals / spacing). */
export function isRealNameChange(current: string, next: string): boolean {
  return nameKey(current) !== nameKey(next)
}

export interface NameEditCheck {
  /** `current` is only needed (and only read from the database) when the patch contains company_name */
  currentName?: string | null
  patch: Record<string, unknown>
}

/** PURE: the reason a hand edit must be refused, or null. */
export function nameEditProblem({ currentName, patch }: NameEditCheck): string | null {
  if (Object.prototype.hasOwnProperty.call(patch, "previous_name") || Object.prototype.hasOwnProperty.call(patch, "name_history")) return NAME_HISTORY_MESSAGE
  if (!Object.prototype.hasOwnProperty.call(patch, "company_name")) return null
  const next = patch.company_name
  if (typeof next !== "string") return NAME_CHANGE_MESSAGE
  if (typeof currentName !== "string") return NAME_CHANGE_MESSAGE      // cannot prove it is only a capitals/spacing fix
  return isRealNameChange(currentName, next) ? NAME_CHANGE_MESSAGE : null
}

/** The reason a hand edit of this account must be refused, or null. Reads the current name only when the patch touches company_name. */
export async function handNameEditProblem(accountId: string, patch: Record<string, unknown>): Promise<string | null> {
  if (!Object.prototype.hasOwnProperty.call(patch, "company_name")) return nameEditProblem({ patch })
  const { data, error } = await db().from("accounts").select("company_name").eq("id", accountId).maybeSingle()
  if (error) return "Could not check the company's current name — please try again."
  return nameEditProblem({ currentName: (data?.company_name as string | undefined) ?? null, patch })
}

// ─────────────────────────────────────────────────────────────── the database calls

export interface NameChangeResult {
  status: "applied" | "already_applied" | "conflict" | "dry_run" | "undone" | "already_undone"
  account_id: string
  old_name?: string
  new_name?: string
  /** conflict: the name the company has now (it changed since the caller looked) */
  current_name?: string
  restored_name?: string
  /** what happened to the storage: applied | already_applied | skipped (reason: no_storage | not_company | study_only | storage_was_not_changed) | dry_run | undone */
  storage?: { status: string; reason?: string; ok?: boolean; problem?: string } & Record<string, unknown>
  dry_run?: boolean
}

function plain(message: string): string {
  return message.replace(/^store: /, "").replace(/^(name change|undo) refused — /, "")
}

async function call(fn: string, args: Record<string, unknown>): Promise<NameChangeResult> {
  const { data, error } = await db().rpc(fn, args)
  if (error) throw new Error(plain(error.message || "The name change could not be made."))
  return data as NameChangeResult
}

/**
 * Change a company's name: the account (compare-and-set on `expectedOldName`), previous_name, the history entry AND the storage move,
 * all in one transaction. `changeId` identifies THIS change: calling again with the same id (a retry, a double click) changes nothing
 * and answers already_applied. A refusal (a capitals-only change, an unexpected storage shape, an upload in progress …) throws with a
 * plain message and nothing has changed. `conflict` = the name changed since you looked. `dryRun` writes nothing.
 */
export async function applyAccountNameChange(p: { accountId: string; changeId: string; newName: string; expectedOldName: string; actor?: string | null; dryRun?: boolean }): Promise<NameChangeResult> {
  return call("store_apply_name_change_for_account", {
    p_account_id: p.accountId, p_change_id: p.changeId, p_new_name: p.newName, p_expected_old_name: p.expectedOldName, p_actor: p.actor ?? null, p_dry_run: p.dryRun ?? false,
  })
}

/** Undo the LATEST name change of a company (refused once the new folders hold files). */
export async function undoAccountNameChange(p: { accountId: string; changeId: string; actor?: string | null; dryRun?: boolean }): Promise<NameChangeResult> {
  return call("store_undo_name_change_for_account", { p_account_id: p.accountId, p_change_id: p.changeId, p_actor: p.actor ?? null, p_dry_run: p.dryRun ?? false })
}
