/**
 * Company Change Name, step "Update our records": apply the NEW name the state approved. One staff action that renames the company
 * (the account, its "previous name", the history) AND moves the old storage folders into "Previous names", in ONE database transaction
 * (applyAccountNameChange → store_apply_name_change_for_account). Nothing else may rename a company any more.
 *
 * Guards, all checked on the server (the panel only mirrors them):
 *   - the job is an active Company Change Name sitting on "Update our records";
 *   - a name is marked FILED, and the state's stamped document is uploaded (at "Waiting for the state") — the new name comes from that
 *     document, so staff types it exactly as printed;
 *   - the typed name is the filed name, or staff explicitly confirms the document prints it differently;
 *   - no lease is still draft / sent / viewed (it carries the old name; a client could sign it);
 *   - the company still has the name we looked at (compare-and-set in the database), and one change per job (a double click or a retry
 *     changes nothing).
 * Pure rules (`applyNameBlockers`, `typedNameDiffersFromFiled`) are separate so they can be tested without a database.
 */
import { supabaseAdmin } from '@/lib/supabase-admin'
import { CHANGE_NAME_STAGES } from '@/lib/flows/change-name-stages'
import { nameDedupeKey, type NameCheck } from '@/lib/flows/name-checks'
import { hasValidLlcEnding } from '@/lib/flows/legal-name'
import { applyAccountNameChange, undoAccountNameChange } from '@/lib/operations/account-name-change'

export const OPEN_LEASE_STATUSES = ['draft', 'sent', 'viewed'] as const

export interface ApplyNameFacts {
  serviceType: string | null | undefined
  jobStatus: string | null | undefined
  stage: string | null | undefined
  filedName: string | null
  hasStampedDocument: boolean
  openLeaseCount: number
  alreadyApplied: boolean
}

/** PURE: the plain-English reasons the name cannot be applied yet (empty = ready). An already applied change has nothing left to block. */
export function applyNameBlockers(f: ApplyNameFacts): string[] {
  if (f.serviceType !== 'Company Change Name') return ['This is not a Company Change Name job.']
  if (f.alreadyApplied) return []
  const out: string[] = []
  if (f.jobStatus !== 'active') out.push('The job is not active.')
  if (f.stage !== CHANGE_NAME_STAGES.records) out.push(`Move the job to "${CHANGE_NAME_STAGES.records}" first (the new name is applied on that step).`)
  if (!f.filedName) out.push('No name is marked as filed with the state.')
  if (!f.hasStampedDocument) out.push(`Upload the state's stamped document on "${CHANGE_NAME_STAGES.wait}" first — the new name is taken from it.`)
  if (f.openLeaseCount > 0) out.push(`A lease for this company is still waiting (draft, sent or viewed) and carries the old name. Finish or remove it first (${f.openLeaseCount} found).`)
  return out
}

/** PURE: true when the typed name is not the name we filed (capitals, commas/periods and a trailing "LLC" do not count). */
export function typedNameDiffersFromFiled(typed: string, filed: string | null): boolean {
  return nameDedupeKey(typed) !== nameDedupeKey(filed)
}

export interface ApplyNameState {
  ok: boolean
  error?: string
  currentName: string | null
  filedName: string | null
  hasStampedDocument: boolean
  blockers: string[]
  /** set once the change is in (also after a reload) */
  applied: { oldName: string | null; newName: string | null } | null
}

interface Loaded {
  sd: { id: string; service_type: string | null; status: string | null; stage: string | null; account_id: string | null; name_checks: unknown }
  account: { id: string; company_name: string | null; name_history: unknown } | null
}

async function load(sdId: string): Promise<Loaded | null> {
  const { data: sd } = await supabaseAdmin
    .from('service_deliveries')
    .select('id, service_type, status, stage, account_id, name_checks')
    .eq('id', sdId)
    .maybeSingle()
  if (!sd) return null
  // name_history is not in the generated types until the storage migrations reach production
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: account } = sd.account_id ? await (supabaseAdmin as any).from('accounts').select('id, company_name, name_history').eq('id', sd.account_id).maybeSingle() : { data: null }
  return { sd: sd as Loaded['sd'], account: (account as Loaded['account']) ?? null }
}

function filedNameOf(checks: unknown): string | null {
  const list = Array.isArray(checks) ? (checks as NameCheck[]) : []
  return list.find((c) => c.status === 'filed')?.name ?? null
}

/** The history entry of THIS job's change that has not been undone since, or null. */
export function appliedEntry(history: unknown, sdId: string): { old_name?: string; new_name?: string } | null {
  const list = Array.isArray(history) ? (history as Array<Record<string, unknown>>) : []
  for (let i = list.length - 1; i >= 0; i--) {
    const e = list[i]
    if (e.change_id !== sdId) continue
    if (e.type === 'undo') return null
    if (e.type === 'change') return { old_name: e.old_name as string | undefined, new_name: e.new_name as string | undefined }
  }
  return null
}

export async function getApplyNameState(sdId: string): Promise<ApplyNameState> {
  const loaded = await load(sdId)
  if (!loaded || loaded.sd.service_type !== 'Company Change Name') {
    return { ok: false, error: 'Name change not found.', currentName: null, filedName: null, hasStampedDocument: false, blockers: [], applied: null }
  }
  const { sd, account } = loaded
  const [{ count: docCount }, { count: leaseCount }] = await Promise.all([
    supabaseAdmin.from('documents').select('id', { count: 'exact', head: true }).eq('service_delivery_id', sd.id).eq('flow_stage', CHANGE_NAME_STAGES.wait),
    sd.account_id
      ? supabaseAdmin.from('lease_agreements').select('id', { count: 'exact', head: true }).eq('account_id', sd.account_id).in('status', [...OPEN_LEASE_STATUSES])
      : Promise.resolve({ count: 0 }),
  ])
  const applied = appliedEntry(account?.name_history, sd.id)
  const filedName = filedNameOf(sd.name_checks)
  const blockers = applyNameBlockers({
    serviceType: sd.service_type,
    jobStatus: sd.status,
    stage: sd.stage,
    filedName,
    hasStampedDocument: (docCount ?? 0) > 0,
    openLeaseCount: leaseCount ?? 0,
    alreadyApplied: applied !== null,
  })
  return {
    ok: true,
    currentName: account?.company_name ?? null,
    filedName,
    hasStampedDocument: (docCount ?? 0) > 0,
    blockers,
    applied: applied ? { oldName: applied.old_name ?? null, newName: applied.new_name ?? null } : null,
  }
}

export interface ApplyNameResult {
  ok: boolean
  error?: string
  /** the typed name is not the filed one and the caller did not confirm */
  mismatch?: { typed: string; filed: string }
  oldName?: string
  newName?: string
  storage?: { status: string; reason?: string; problem?: string } & Record<string, unknown>
  alreadyApplied?: boolean
}

/**
 * PURE: an LLC that is renamed must stay an LLC by name — the typed new name must carry a valid ending (LLC, L.L.C., Limited Liability
 * Company…), exactly as the state's document prints it. A company whose CURRENT name has no LLC ending (a corporation, a legacy record) is
 * not held to it. Returns the plain sentence for staff, or null (job 80cce1cb — before this, typing "Acme" for "Old Name LLC" saved a
 * company named "Acme" without its ending).
 */
export function newNameEndingProblem(currentName: string | null | undefined, typedName: string): string | null {
  if (!hasValidLlcEnding(currentName)) return null
  if (hasValidLlcEnding(typedName)) return null
  return `The new name "${typedName}" has no LLC ending. Type it exactly as the state's document prints it — it must end in LLC, L.L.C. or Limited Liability Company.`
}

export async function applyNewName(p: { sdId: string; typedName: string; confirmMismatch?: boolean; actorId: string; actorLabel: string }): Promise<ApplyNameResult> {
  const typed = (p.typedName ?? '').replace(/\s+/g, ' ').trim()
  if (!typed) return { ok: false, error: 'Type the new name exactly as printed on the state\'s document.' }
  if (typed.length > 200) return { ok: false, error: 'That name is too long.' }

  const state = await getApplyNameState(p.sdId)
  if (!state.ok) return { ok: false, error: state.error }
  if (state.applied) return { ok: true, alreadyApplied: true, oldName: state.applied.oldName ?? undefined, newName: state.applied.newName ?? undefined }
  if (state.blockers.length > 0) return { ok: false, error: state.blockers.join(' ') }
  if (!state.currentName) return { ok: false, error: 'The company has no name on record.' }
  const endingProblem = newNameEndingProblem(state.currentName, typed)
  if (endingProblem) return { ok: false, error: endingProblem }

  if (typedNameDiffersFromFiled(typed, state.filedName) && !p.confirmMismatch) {
    return {
      ok: false,
      mismatch: { typed, filed: state.filedName ?? '' },
      error: `The name you typed ("${typed}") is not the name we filed ("${state.filedName}"). If the state's document really prints it this way, confirm and try again.`,
    }
  }

  const loaded = await load(p.sdId)
  if (!loaded?.sd.account_id) return { ok: false, error: 'This job has no company.' }
  let result
  try {
    result = await applyAccountNameChange({ accountId: loaded.sd.account_id, changeId: p.sdId, newName: typed, expectedOldName: state.currentName, actor: p.actorId })
  } catch (err) {
    return { ok: false, error: sentence(err instanceof Error && err.message ? err.message : 'The name change could not be made.') }
  }
  if (result.status === 'conflict') {
    return { ok: false, error: `The company's name is now "${result.current_name}" — it changed since this page loaded. Reload and check.` }
  }
  if (result.status === 'applied') await logNameChange(loaded.sd.account_id, result.old_name ?? state.currentName, result.new_name ?? typed, p.actorLabel)
  return {
    ok: true,
    alreadyApplied: result.status === 'already_applied',
    oldName: result.old_name,
    newName: result.new_name,
    storage: result.storage,
  }
}

/** The database refuses in a lower-case fragment ("the new folders already hold files …"); staff read it on screen as a sentence. */
export function sentence(message: string): string {
  const m = message.trim()
  if (!m) return m
  const s = m.charAt(0).toUpperCase() + m.slice(1)
  return /[.!?]$/.test(s) ? s : `${s}.`
}

/** CRM update rule: every client-facing change leaves a dated line in the company's notes. Best-effort — the change itself is already done. */
async function appendCompanyNote(accountId: string, line: string): Promise<void> {
  try {
    const { data: acct } = await supabaseAdmin.from('accounts').select('notes').eq('id', accountId).maybeSingle()
    const day = new Date().toISOString().slice(0, 10)
    const notes = [acct?.notes, `${day}: ${line}`].filter(Boolean).join('\n')
    // eslint-disable-next-line no-restricted-syntax -- a dated CRM note line (CRM update rule); the change itself went through the database function
    await supabaseAdmin.from('accounts').update({ notes }).eq('id', accountId)
  } catch (err) {
    console.error('change-name-apply: could not write the CRM note:', err)
  }
}

async function logNameChange(accountId: string, oldName: string, newName: string, who: string): Promise<void> {
  await appendCompanyNote(accountId, `Company renamed from "${oldName}" to "${newName}" (Company Change Name, applied by ${who}). Old storage folders moved to "Previous names".`)
}

// ─────────────────────────────────────────────────────────────── undo

/** PURE: why the name change cannot be undone from the workspace right now, or null. */
export function undoBlocker(f: { serviceType: string | null | undefined; stage: string | null | undefined; applied: boolean }): string | null {
  if (f.serviceType !== 'Company Change Name') return 'This is not a Company Change Name job.'
  if (!f.applied) return 'There is no name change to undo — the new name has not been applied.'
  if (f.stage !== CHANGE_NAME_STAGES.records) {
    return `The job has moved on from "${CHANGE_NAME_STAGES.records}". Move it back to that step first — a name change can only be undone there, before the client is asked for the new Operating Agreement.`
  }
  return null
}

export interface UndoNameResult {
  ok: boolean
  error?: string
  restoredName?: string
  alreadyUndone?: boolean
}

/**
 * Undo the name change this job applied: the company gets its old name back (and its old "previous name"), the new empty folders go,
 * the old folders come back — one database transaction (undoAccountNameChange). The database refuses once the new folders hold anything,
 * or when a later name change exists; its message is passed on in plain words.
 */
export async function undoNewName(p: { sdId: string; actorId: string; actorLabel: string }): Promise<UndoNameResult> {
  const state = await getApplyNameState(p.sdId)
  if (!state.ok) return { ok: false, error: state.error }
  const loaded = await load(p.sdId)
  if (!loaded?.sd.account_id) return { ok: false, error: 'This job has no company.' }
  const blocker = undoBlocker({ serviceType: loaded.sd.service_type, stage: loaded.sd.stage, applied: state.applied !== null })
  if (blocker) return { ok: false, error: blocker }

  let result
  try {
    result = await undoAccountNameChange({ accountId: loaded.sd.account_id, changeId: p.sdId, actor: p.actorId })
  } catch (err) {
    return { ok: false, error: sentence(err instanceof Error && err.message ? err.message : 'The name change could not be undone.') }
  }
  if (result.status === 'conflict') {
    return { ok: false, error: `The company's name is now "${result.current_name}" — it changed after this name change, so it cannot be undone from here.` }
  }
  if (result.status === 'undone') {
    await appendCompanyNote(loaded.sd.account_id, `Name change undone: the company is "${result.restored_name}" again (Company Change Name, undone by ${p.actorLabel}). Old storage folders moved back.`)
  }
  return { ok: true, restoredName: result.restored_name, alreadyUndone: result.status === 'already_undone' }
}
