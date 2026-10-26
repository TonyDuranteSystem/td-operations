/**
 * The frozen wording on an offer (flexible-offer slice 2, step B). SERVER-ONLY.
 *
 * The contract page of an offer that sells a NEW service (contract type custom_<slug>) renders that service's
 * wording from offers.contract_texts — a copy taken when the offer is sent — never from the live store, so a
 * later version can never change what a client was shown or signed. The copy is taken in three places:
 * when the offer is sent (publishOffer), by the Activate Lead button (it sends credentials for a draft offer),
 * and — as a safety net — the first time a client's page asks for an offer that has none (the offer view route).
 * An entry already in the copy is NEVER replaced.
 */
import { supabaseAdmin } from '@/lib/supabase-admin'
import { isCustomContractType } from '@/lib/offers/standalone-contract-types'
import { isLegacyServiceType } from '@/lib/services'
import { getApprovedByType } from '@/lib/contracts/service-contract-texts'
import { validateContractWording, type ContractTextSnapshot } from '@/lib/contracts/contract-wording'

export type OfferContractTexts = Record<string, ContractTextSnapshot>

function linesOf(v: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(v)) return []
  return (v as unknown[]).filter((l): l is Record<string, unknown> => !!l && typeof l === 'object')
}

/** Distinct custom contract types an offer needs wording for: its own type, its lines, every package option's lines. */
export function customTypesOnOffer(src: { contractType?: unknown; services?: unknown; packages?: unknown }): string[] {
  const found: unknown[] = [src.contractType]
  for (const l of linesOf(src.services)) found.push(l.contract_type)
  for (const pkg of linesOf(src.packages)) for (const l of linesOf(pkg.services)) found.push(l.contract_type)
  return Array.from(new Set(found.filter(isCustomContractType)))
}

/**
 * Pipeline names of the service lines that name a NEW (non-historical) service but carry no contract type — an offer
 * built before the service had its contract (the CRM copies the catalog's contract type onto a line when the offer is
 * created). Such a line would silently drop out of the agreement the client signs.
 */
export function untypedServiceNames(src: { services?: unknown; packages?: unknown }): string[] {
  const names: string[] = []
  const take = (l: Record<string, unknown>) => {
    const name = typeof l.pipeline_type === 'string' ? l.pipeline_type : ''
    const ct = typeof l.contract_type === 'string' ? l.contract_type.trim() : ''
    if (name.trim() && !ct && !isLegacyServiceType(name)) names.push(name)
  }
  for (const l of linesOf(src.services)) take(l)
  for (const pkg of linesOf(src.packages)) for (const l of linesOf(pkg.services)) take(l)
  return Array.from(new Set(names))
}

/** Pure: give each untyped line the custom contract type of the catalog service with its pipeline name. Never overwrites a type. */
export function fillLineContractTypes(lines: unknown, typeByPipeline: Record<string, string>): { lines: unknown; changed: boolean } {
  if (!Array.isArray(lines)) return { lines, changed: false }
  let changed = false
  const out = (lines as unknown[]).map((l) => {
    if (!l || typeof l !== 'object' || Array.isArray(l)) return l
    const line = l as Record<string, unknown>
    const name = typeof line.pipeline_type === 'string' ? line.pipeline_type : ''
    const have = typeof line.contract_type === 'string' ? line.contract_type.trim() : ''
    const want = typeByPipeline[name]
    if (!have && want && isCustomContractType(want)) { changed = true; return { ...line, contract_type: want } }
    return l
  })
  return { lines: changed ? out : lines, changed }
}

/** Pure: the same for every package option's own service lines. */
export function fillPackageContractTypes(packages: unknown, typeByPipeline: Record<string, string>): { packages: unknown; changed: boolean } {
  if (!Array.isArray(packages)) return { packages, changed: false }
  let changed = false
  const out = (packages as unknown[]).map((p) => {
    if (!p || typeof p !== 'object' || Array.isArray(p)) return p
    const pkg = p as Record<string, unknown>
    const filled = fillLineContractTypes(pkg.services, typeByPipeline)
    if (!filled.changed) return p
    changed = true
    return { ...pkg, services: filled.lines }
  })
  return { packages: changed ? out : packages, changed }
}

/** The custom contract type of each named service, by pipeline name, from the live catalog (an active row beats a switched-off one). */
export async function customContractTypesByPipeline(names: string[]): Promise<Record<string, string>> {
  const { data, error } = await supabaseAdmin.from('catalog_entries').select('slug, status, metadata').eq('catalog_id', 'services')
  if (error) throw new Error(`could not read the Service Catalog (${error.message})`)
  const wanted = new Set(names)
  const rows = [...(data ?? [])].sort((a, b) => {
    const aa = a.status === 'active' ? 0 : 1
    const bb = b.status === 'active' ? 0 : 1
    return aa !== bb ? aa - bb : a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0
  })
  const out: Record<string, string> = {}
  for (const r of rows) {
    const meta = (r.metadata ?? {}) as Record<string, unknown>
    const pipeline = typeof meta.pipeline === 'string' ? meta.pipeline.trim() : ''
    if (!wanted.has(pipeline) || pipeline in out) continue
    const ct = typeof meta.contract_type === 'string' ? meta.contract_type.trim() : ''
    if (isCustomContractType(ct)) out[pipeline] = ct
    else out[pipeline] = '' // the first (best) row for this name decides; a non-custom type is left alone
  }
  for (const k of Object.keys(out)) if (!out[k]) delete out[k]
  return out
}

/** Which of the needed types already have a valid frozen entry. */
function validEntries(existing: unknown): OfferContractTexts {
  const out: OfferContractTexts = {}
  if (!existing || typeof existing !== 'object' || Array.isArray(existing)) return out
  for (const [type, entry] of Object.entries(existing as Record<string, unknown>)) {
    if (!isCustomContractType(type) || !entry || typeof entry !== 'object') continue
    if (validateContractWording((entry as ContractTextSnapshot).content).ok) out[type] = entry as ContractTextSnapshot
  }
  return out
}

export interface EnsureResult {
  /** The offer's frozen wording after this call (existing entries untouched, missing ones added when an approved version exists). */
  texts: OfferContractTexts
  /** Needed types for which no frozen entry exists and no approved version could be found. */
  missing: string[]
  /** True when this call wrote a new entry. */
  changed: boolean
  /** Set when this call also gave untyped new-service lines their contract type (the offer's lines as they are now). */
  lines?: { services: unknown; packages: unknown }
}

/** Pure part: merge freshly read approved rows into the existing frozen copy without replacing anything. */
export function mergeSnapshot(
  needed: string[],
  existing: unknown,
  approved: Record<string, { version: number; content_hash: string; content: unknown }>,
  now: Date = new Date(),
): EnsureResult {
  const texts = validEntries(existing)
  const missing: string[] = []
  let changed = false
  for (const type of needed) {
    if (texts[type]) continue
    const row = approved[type]
    if (!row || !validateContractWording(row.content).ok) { missing.push(type); continue }
    texts[type] = { version: row.version, hash: row.content_hash, content: row.content, snapshot_at: now.toISOString() }
    changed = true
  }
  return { texts, missing, changed }
}

const NOT_SWITCHED_ON = 'Contracts for new services are not switched on yet: the database change that stores them has not been applied.'
const plainDbError = (what: string, message: string): string =>
  /contract_texts/i.test(message) && /does not exist|schema cache|could not find/i.test(message) ? NOT_SWITCHED_ON : `${what} (${message})`

export interface EnsureOptions {
  /**
   * The offer is being SENT now (draft -> sent): take a FRESH copy of the approved wording and replace whatever an earlier
   * preview or failed attempt left. The wording is frozen at the moment of the real send, never earlier.
   */
  refresh?: boolean
  /** false = a staff preview of a DRAFT offer: work everything out in memory and write nothing (default true). */
  persist?: boolean
}

/**
 * Freeze (or complete) the wording copy of the offer stored under `token`.
 *  - An offer with no new service answers without touching the contract store OR the contract_texts column at all
 *    (so the code is safe to run before the database change exists, for every ordinary offer).
 *  - refresh: a new copy of every needed type, replacing any older one (used when the offer is sent).
 *  - persist: false: nothing is written — a preview shows today's approved wording without freezing it.
 *  - default: complete the copy, never replacing an entry already frozen (the safety net for an offer that is
 *    already out and has none).
 */
export async function ensureOfferContractTexts(token: string, opts: EnsureOptions = {}): Promise<EnsureResult> {
  const persist = opts.persist !== false
  const { data, error } = await supabaseAdmin
    .from('offers')
    // eslint-disable-next-line no-restricted-syntax -- packages postdates the generated types
    .select('contract_type, services, packages' as never)
    .eq('token', token)
    .maybeSingle()
  if (error) throw new Error(`could not read the offer's contract wording (${error.message})`)
  if (!data) return { texts: {}, missing: [], changed: false }
  const row = data as unknown as { contract_type?: unknown; services?: unknown; packages?: unknown }

  // An offer built BEFORE its new service had a contract has lines with no contract type; the service would drop out of
  // the agreement the client signs. Give those lines the service's own type now, from the live catalog.
  let services = row.services
  let packages = row.packages
  let linesFilled = false
  const untyped = untypedServiceNames({ services, packages })
  if (untyped.length > 0) {
    const typeByPipeline = await customContractTypesByPipeline(untyped)
    if (Object.keys(typeByPipeline).length > 0) {
      const s = fillLineContractTypes(services, typeByPipeline)
      const p = fillPackageContractTypes(packages, typeByPipeline)
      if (s.changed || p.changed) {
        if (persist) {
          const patch: Record<string, unknown> = {}
          if (s.changed) patch.services = s.lines
          if (p.changed) patch.packages = p.packages
          const { error: lineErr } = await supabaseAdmin
            .from('offers')
            // eslint-disable-next-line no-restricted-syntax -- packages postdates the generated types
            .update(patch as never)
            .eq('token', token)
          if (lineErr) throw new Error(`could not save the contract type on the offer's services (${lineErr.message})`)
        }
        if (s.changed) services = s.lines
        if (p.changed) packages = p.packages
        linesFilled = true
      }
    }
  }
  const withLines = <T extends EnsureResult>(r: T): T => (linesFilled ? { ...r, lines: { services, packages } } : r)

  const needed = customTypesOnOffer({ contractType: row.contract_type, services, packages })
  if (needed.length === 0) return withLines({ texts: {}, missing: [], changed: false })

  // The existing copy is only read when it matters: completing a copy that is already out. A refresh and a preview start from nothing.
  let existing: unknown = null
  if (persist && !opts.refresh) {
    const { data: c, error: cErr } = await supabaseAdmin
      .from('offers')
      // eslint-disable-next-line no-restricted-syntax -- contract_texts postdates the generated types
      .select('contract_texts' as never)
      .eq('token', token)
      .maybeSingle()
    if (cErr) throw new Error(plainDbError("could not read the offer's contract wording", cErr.message))
    existing = (c as unknown as { contract_texts?: unknown } | null)?.contract_texts ?? null
  }

  const have = validEntries(existing)
  const lacking = needed.filter((t) => !have[t])
  if (lacking.length === 0) return withLines({ texts: have, missing: [], changed: false })

  const approved = await getApprovedByType(lacking)
  const merged = mergeSnapshot(needed, existing, approved)
  const mustWrite = persist && (opts.refresh ? merged.missing.length === 0 : merged.changed)
  if (mustWrite) {
    const { error: upErr } = await supabaseAdmin
      .from('offers')
      // eslint-disable-next-line no-restricted-syntax -- contract_texts postdates the generated types
      .update({ contract_texts: merged.texts } as never)
      .eq('token', token)
    if (upErr) throw new Error(plainDbError("could not save the offer's contract wording", upErr.message))
  }
  return withLines(opts.refresh ? { ...merged, changed: mustWrite } : merged)
}
