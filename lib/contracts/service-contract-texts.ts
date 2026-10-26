/**
 * Stored contract wording of NEW services (flexible-offer slice 2, step B). SERVER-ONLY.
 *
 * One row per version in service_contract_texts: draft -> approved -> superseded. The database enforces the
 * rules that must never depend on application code (approved wording is immutable, one open draft and one
 * approved version per service, atomic approval bound to the fingerprint the approver read — see migration
 * 20261026-1000). This file is the only code that reads and writes the table. WHO may approve is decided by
 * the caller (the approve route requires an owner); this module records the name it is given.
 *
 * The table postdates the generated database types, so it is reached through an untyped client.
 */
import { supabaseAdmin } from '@/lib/supabase-admin'
import { getEntryById, updateMetadata, type Actor } from '@/lib/catalog/framework'
import { customContractTypeForSlug, isCustomContractType, isBuiltInAgreementType, type CustomContractType } from '@/lib/offers/standalone-contract-types'
import { validateContractWording, type ContractWording } from '@/lib/contracts/contract-wording'

// The database refuses any other value (the lock trigger in migration 20261026-1000 — NOT a CHECK constraint, so the
// shared-sandbox "code <-> database contract" CI check has nothing to register). A unit test keeps these lists
// identical to the ones inside that trigger.
export const CONTRACT_TEXT_STATUSES = ['draft', 'approved', 'superseded'] as const
export const CONTRACT_TEXT_SOURCES = ['claude_draft', 'claude_change', 'manual', 'session'] as const
export type ContractTextStatus = (typeof CONTRACT_TEXT_STATUSES)[number]
export type ContractTextSource = (typeof CONTRACT_TEXT_SOURCES)[number]

export interface ContractTextRow {
  id: string
  service_entry_id: string
  contract_type: CustomContractType
  version: number
  status: ContractTextStatus
  content: unknown
  content_hash: string
  source: ContractTextSource
  note: string | null
  created_by: string
  created_at: string
  approved_by: string | null
  approved_at: string | null
  superseded_at: string | null
}

export class ContractTextError extends Error {
  code: 'INVALID_WORDING' | 'NOT_FOUND' | 'BUILT_IN_CONTRACT' | 'DRAFT_EXISTS' | 'NOT_A_DRAFT' | 'DRAFT_CHANGED' | 'NO_APPROVER' | 'NOT_READY' | 'TYPE_IN_USE' | 'DB'
  details?: string[]
  constructor(code: ContractTextError['code'], message: string, details?: string[]) {
    super(message)
    this.code = code
    this.details = details
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const table = () => (supabaseAdmin as any).from('service_contract_texts')

function dbError(e: { message?: string } | null | undefined): ContractTextError {
  const m = e?.message ?? 'database error'
  if (/DRAFT_CHANGED/.test(m)) return new ContractTextError('DRAFT_CHANGED', 'The wording changed after you read it — open it again and read the new text before approving.')
  if (/NOT_A_DRAFT/.test(m)) return new ContractTextError('NOT_A_DRAFT', 'Only a draft can be approved.')
  if (/NO_APPROVER/.test(m)) return new ContractTextError('NO_APPROVER', 'An approver is required.')
  if (/NOT_FOUND/.test(m)) return new ContractTextError('NOT_FOUND', 'That contract version no longer exists.')
  if (/service_contract_texts_one_draft/.test(m)) return new ContractTextError('DRAFT_EXISTS', 'This service already has an open draft — edit that one.')
  // The table (or the approve function) is not in this database yet: the migration has not been run here.
  if (/does not exist|schema cache|Could not find the (table|function)/i.test(m)) {
    return new ContractTextError('NOT_READY', 'Contracts for new services are not switched on yet: the database change that stores them has not been applied.')
  }
  return new ContractTextError('DB', m)
}

function checkWording(content: unknown): ContractWording {
  const res = validateContractWording(content)
  // (`'errors' in res`, not `!res.ok`: this project's TypeScript settings do not narrow on the boolean tag)
  if ('errors' in res) throw new ContractTextError('INVALID_WORDING', 'The wording is not valid: ' + res.errors.join('; '), res.errors)
  return res.wording
}

/**
 * Make sure the service carries its own contract type (custom_<slug>) so offer lines pick it up from the
 * catalog. A service that already has a built-in type (e.g. shipping) has its contract in code — refused here.
 */
export async function ensureContractType(entryId: string, actor: Actor): Promise<CustomContractType> {
  const entry = await getEntryById(entryId)
  if (!entry) throw new ContractTextError('NOT_FOUND', 'That service does not exist.')
  const meta = (entry.metadata ?? {}) as Record<string, unknown>
  const current = typeof meta.contract_type === 'string' ? meta.contract_type.trim() : ''
  if (isCustomContractType(current)) {
    // a custom type is only ever set by this module, from the slug; one typed by hand into the Contract type box is refused
    if (current !== customContractTypeForSlug(entry.slug)) {
      throw new ContractTextError('TYPE_IN_USE', `The contract type "${current}" does not belong to this service (it was typed by hand). Clear the Contract type box, save, and create the contract again.`)
    }
    return current
  }
  if (current) {
    throw new ContractTextError('BUILT_IN_CONTRACT', isBuiltInAgreementType(current)
      ? `"${entry.display_name}" already uses the built-in "${current}" contract.`
      : `"${entry.display_name}" has the contract type "${current}", which is not a contract the system knows. Clear that box in the Service Catalog first.`)
  }
  const type = customContractTypeForSlug(entry.slug)
  if (!type) throw new ContractTextError('INVALID_WORDING', 'The service has no usable short name (slug).')
  // Two services must never share a contract type: an offer would freeze one service's wording for the other.
  const { data: clash, error: clashErr } = await supabaseAdmin
    .from('catalog_entries')
    .select('id, display_name')
    .eq('catalog_id', 'services')
    .eq('metadata->>contract_type', type)
    .neq('id', entryId)
    .limit(1)
  if (clashErr) throw new ContractTextError('DB', clashErr.message)
  if (clash && clash.length > 0) {
    throw new ContractTextError('TYPE_IN_USE', `The contract type "${type}" is already used by "${clash[0].display_name}". Two services cannot share one — rename this service's short name (slug) or ask a developer.`)
  }
  await updateMetadata(entryId, { ...meta, contract_type: type }, 'New service contract: the service gets its own contract type', actor)
  return type
}

export async function getOpenDraft(entryId: string): Promise<ContractTextRow | null> {
  const { data, error } = await table().select('*').eq('service_entry_id', entryId).eq('status', 'draft').maybeSingle()
  if (error) throw dbError(error)
  return (data as ContractTextRow | null) ?? null
}

export async function getApproved(entryId: string): Promise<ContractTextRow | null> {
  const { data, error } = await table().select('*').eq('service_entry_id', entryId).eq('status', 'approved').maybeSingle()
  if (error) throw dbError(error)
  return (data as ContractTextRow | null) ?? null
}

export async function getVersion(id: string): Promise<ContractTextRow | null> {
  const { data, error } = await table().select('*').eq('id', id).maybeSingle()
  if (error) throw dbError(error)
  return (data as ContractTextRow | null) ?? null
}

/** Every version of a service's contract, newest first. */
export async function listVersions(entryId: string): Promise<ContractTextRow[]> {
  const { data, error } = await table().select('*').eq('service_entry_id', entryId).order('version', { ascending: false })
  if (error) throw dbError(error)
  return (data as ContractTextRow[]) ?? []
}

/** The approved version for each of the given contract types (types with none are simply absent). */
export async function getApprovedByType(types: string[]): Promise<Record<string, ContractTextRow>> {
  const wanted = Array.from(new Set(types.filter(isCustomContractType)))
  if (wanted.length === 0) return {}
  const { data, error } = await table().select('*').in('contract_type', wanted).eq('status', 'approved')
  if (error) throw dbError(error)
  const out: Record<string, ContractTextRow> = {}
  for (const r of (data as ContractTextRow[]) ?? []) out[r.contract_type] = r
  return out
}

export interface ContractStatus {
  state: 'none' | 'draft' | 'approved'
  /** Highest version number that exists (0 = none). */
  latestVersion: number
  approvedVersion: number | null
  hasOpenDraft: boolean
}

export async function contractStatusForEntry(entryId: string): Promise<ContractStatus> {
  const versions = await listVersions(entryId)
  const approved = versions.find((v) => v.status === 'approved') ?? null
  const draft = versions.find((v) => v.status === 'draft') ?? null
  return {
    state: approved ? 'approved' : draft ? 'draft' : 'none',
    latestVersion: versions[0]?.version ?? 0,
    approvedVersion: approved?.version ?? null,
    hasOpenDraft: !!draft,
  }
}

/** Create the service's open draft (version = next number). Refuses when a draft is already open. */
export async function createDraft(p: {
  entryId: string
  content: unknown
  source: ContractTextSource
  createdBy: string
  note?: string | null
  actor: Actor
}): Promise<ContractTextRow> {
  const wording = checkWording(p.content)
  const type = await ensureContractType(p.entryId, p.actor)
  const { data, error } = await table()
    .insert({ service_entry_id: p.entryId, contract_type: type, content: wording, source: p.source, note: p.note ?? null, created_by: p.createdBy })
    .select('*')
    .single()
  if (error) throw dbError(error)
  return data as ContractTextRow
}

/**
 * Replace the wording of an OPEN draft (the database refuses anything that is not a draft). With `expectedHash` the
 * save only happens if the draft is still the one the caller read — two people (or two tabs) cannot silently
 * overwrite each other.
 */
export async function saveDraft(p: { id: string; content: unknown; source?: ContractTextSource; note?: string | null; expectedHash?: string }): Promise<ContractTextRow> {
  const wording = checkWording(p.content)
  const patch: Record<string, unknown> = { content: wording }
  if (p.source) patch.source = p.source
  if (p.note !== undefined) patch.note = p.note
  let q = table().update(patch).eq('id', p.id).eq('status', 'draft')
  if (p.expectedHash) q = q.eq('content_hash', p.expectedHash)
  const { data, error } = await q.select('*').maybeSingle()
  if (error) throw dbError(error)
  if (!data) {
    if (p.expectedHash) {
      const now = await getVersion(p.id)
      if (now && now.status === 'draft') throw new ContractTextError('DRAFT_CHANGED', 'This draft was changed somewhere else (another tab or person). Close it and open it again to see the latest.')
    }
    throw new ContractTextError('NOT_A_DRAFT', 'That draft is no longer open.')
  }
  return data as ContractTextRow
}

/** Throw away an open draft. True when a draft was removed; false when there was nothing to remove (it was approved or gone meanwhile). */
export async function discardDraft(id: string): Promise<boolean> {
  const { data, error } = await table().delete().eq('id', id).eq('status', 'draft').select('id')
  if (error) throw dbError(error)
  return Array.isArray(data) && data.length > 0
}

/**
 * Approve a draft: atomic in the database (the previously approved version becomes replaced) and bound to
 * the fingerprint the approver READ. The caller must already have checked that the approver is an owner.
 */
export async function approveDraft(p: { id: string; expectedHash: string; approvedBy: string }): Promise<ContractTextRow> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabaseAdmin as any).rpc('approve_service_contract_text', {
    p_id: p.id,
    p_expected_hash: p.expectedHash,
    p_approved_by: p.approvedBy,
  })
  if (error) throw dbError(error)
  return data as ContractTextRow
}

/**
 * How many offers carry each version's wording (the frozen copy on the offer, taken when it was sent), keyed by version
 * number. Matches the version AND its fingerprint, so two versions with identical wording are not counted twice.
 * Versions nobody has sent are simply 0.
 */
export async function offersSentByVersion(type: string, versions: Array<{ version: number; hash: string }>): Promise<Record<number, number>> {
  if (!isCustomContractType(type)) return {}
  const out: Record<number, number> = {}
  await Promise.all(versions.map(async ({ version, hash }) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { count, error } = await (supabaseAdmin as any)
      .from('offers')
      .select('id', { count: 'exact', head: true })
      .neq('status', 'draft') // a draft (or a preview of one) has not been sent
      .eq(`contract_texts->${type}->>version`, String(version))
      .eq(`contract_texts->${type}->>hash`, hash)
    if (error) throw dbError(error)
    out[version] = count ?? 0
  }))
  return out
}
