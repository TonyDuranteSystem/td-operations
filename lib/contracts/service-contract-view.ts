/**
 * What the Service Catalog's Contract card and pop-up need to know about one service's contract (step B).
 * SERVER-ONLY. The browser never reads the contract table; it asks the /api/service-contracts routes, which build
 * their answers here. Pure helpers (`contractEligibility`, `staffNameFromEmail`) are exported for tests.
 */
import { getEntryById } from '@/lib/catalog/framework'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { isBuiltInAgreementType, isCustomContractType } from '@/lib/offers/standalone-contract-types'
import { isLegacyServiceType } from '@/lib/services'
import { listVersions, offersSentByVersion, ContractTextError, type ContractTextRow } from '@/lib/contracts/service-contract-texts'
import type { ServiceFacts } from '@/lib/contracts/draft-with-claude'

/**
 * new         = a service created here (steps of its own, no original contract): its contract is written here
 * built_in    = one of the eight contracts kept in code, or the full formation / onboarding agreement: nothing to write here
 * legacy      = one of the ORIGINAL services (EIN, DBA, Banking …): giving it a contract type would change every offer that
 *               contains it, so it is never offered here
 * no_pipeline = no steps yet (a contract is drafted from the service's steps; a service with none cannot be sold as a job)
 * other       = a contract type this system does not recognise (a typo)
 */
export type ContractKind = 'new' | 'built_in' | 'legacy' | 'no_pipeline' | 'other'

const FULL_AGREEMENTS = new Set(['formation', 'onboarding'])

export function contractEligibility(contractType: string | null | undefined, pipeline: string | null | undefined): { kind: ContractKind; note: string | null } {
  const t = (contractType ?? '').trim()
  const p = (pipeline ?? '').trim()
  if (isCustomContractType(t)) return { kind: 'new', note: null }
  if (isBuiltInAgreementType(t)) return { kind: 'built_in', note: `This service uses the built-in “${t}” contract. Its wording is kept in the system, so there is nothing to set up here.` }
  if (FULL_AGREEMENTS.has(t)) return { kind: 'built_in', note: `This service uses the full “${t}” agreement, which is set up elsewhere in the system, so there is nothing to create here.` }
  // an ORIGINAL service is never offered a contract here, whatever contract value it carries (e.g. "renewal")
  if (p && isLegacyServiceType(p)) return { kind: 'legacy', note: 'This is one of the original services. Its agreement is handled elsewhere in the system, so a contract is not created here.' }
  if (t) return { kind: 'other', note: `The Contract type box says “${t}”, which is not one of the system’s service agreements. If this service needs its own agreement, clear that box, save, and create the contract here.` }
  if (!p) return { kind: 'no_pipeline', note: 'This service has no steps yet (no pipeline name). A contract written here is drafted from the service’s steps: add them above, save, then create the contract.' }
  return { kind: 'new', note: null }
}

/** "antonio.durante@tonydurante.us" -> "Antonio Durante" (for "Approved by …"); anything else is shown as it is. */
export function staffNameFromEmail(value: string | null | undefined): string {
  const v = (value ?? '').trim()
  if (!v) return ''
  if (!v.includes('@')) return v
  return v
    .split('@')[0]
    .split(/[._-]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ')
}

export interface ContractVersionView {
  id: string
  version: number
  status: 'draft' | 'approved' | 'superseded'
  source: string
  note: string | null
  createdBy: string
  createdAt: string
  approvedBy: string | null
  approvedAt: string | null
  hash: string
  /** How many offers carry this exact wording. */
  offersSent: number
  content: unknown
}

export interface ContractView {
  service: { id: string; name: string; slug: string; price: number | null; currency: string; description: string | null }
  kind: ContractKind
  /** Plain-English reason when the service cannot have a contract written here (kind is not 'new'). */
  note: string | null
  contractType: string | null
  state: 'none' | 'draft' | 'approved'
  versions: ContractVersionView[]
}

export function toVersionView(r: ContractTextRow, offersSent = 0): ContractVersionView {
  return {
    id: r.id,
    version: r.version,
    status: r.status,
    source: r.source,
    note: r.note,
    createdBy: r.created_by,
    createdAt: r.created_at,
    approvedBy: r.approved_by,
    approvedAt: r.approved_at,
    hash: r.content_hash,
    offersSent,
    content: r.content,
  }
}

function priceOf(meta: Record<string, unknown>): number | null {
  const p = meta.default_price
  if (typeof p === 'number' && Number.isFinite(p)) return p
  if (typeof p === 'string' && p.trim() !== '' && Number.isFinite(Number(p))) return Number(p)
  return null
}

export async function loadContractView(entryId: string): Promise<ContractView> {
  const entry = await getEntryById(entryId)
  if (!entry || entry.catalog_id !== 'services') throw new ContractTextError('NOT_FOUND', 'That service does not exist.')
  const meta = (entry.metadata ?? {}) as Record<string, unknown>
  const contractType = typeof meta.contract_type === 'string' && meta.contract_type.trim() ? meta.contract_type.trim() : null
  const pipeline = typeof meta.pipeline === 'string' ? meta.pipeline : null
  const { kind, note } = contractEligibility(contractType, pipeline)

  let rows: ContractTextRow[] = []
  let sent: Record<number, number> = {}
  if (kind === 'new') {
    rows = await listVersions(entryId)
    if (rows.length > 0 && isCustomContractType(rows[0].contract_type)) {
      sent = await offersSentByVersion(rows[0].contract_type, rows.map((r) => ({ version: r.version, hash: r.content_hash })))
    }
  }
  const approved = rows.find((r) => r.status === 'approved')
  const draft = rows.find((r) => r.status === 'draft')
  return {
    service: {
      id: entry.id,
      name: entry.display_name,
      slug: entry.slug,
      price: priceOf(meta),
      currency: typeof meta.default_currency === 'string' && meta.default_currency ? meta.default_currency : 'USD',
      description: entry.description,
    },
    kind,
    note,
    contractType,
    state: approved ? 'approved' : draft ? 'draft' : 'none',
    versions: rows.map((r) => toVersionView(r, sent[r.version] ?? 0)),
  }
}

/** What Claude is told about a service when it drafts or changes its contract. */
export async function loadServiceFacts(entryId: string): Promise<ServiceFacts> {
  const entry = await getEntryById(entryId)
  if (!entry || entry.catalog_id !== 'services') throw new ContractTextError('NOT_FOUND', 'That service does not exist.')
  const meta = (entry.metadata ?? {}) as Record<string, unknown>
  const pipeline = typeof meta.pipeline === 'string' ? meta.pipeline.trim() : ''
  let steps: string[] = []
  if (pipeline) {
    const { data, error } = await supabaseAdmin
      .from('pipeline_stages')
      .select('stage_name, stage_order')
      .eq('service_type', pipeline)
      .order('stage_order', { ascending: true })
    if (error) throw new ContractTextError('DB', error.message)
    steps = (data ?? []).map((s) => String(s.stage_name ?? '').trim()).filter(Boolean)
  }
  return {
    name: entry.display_name,
    description: entry.description,
    price: priceOf(meta),
    currency: typeof meta.default_currency === 'string' && meta.default_currency ? meta.default_currency : 'USD',
    steps,
  }
}
