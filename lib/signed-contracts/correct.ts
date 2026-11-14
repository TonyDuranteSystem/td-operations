/**
 * Server side: correct the installment amounts saved for a signed contract (the Edit on the Signed contracts card).
 *
 * What it changes, and what it does not:
 *  - formation / onboarding: the saved amounts on the contract (`contracts.annual_fee` = January + June, and `installments`
 *    in the exact shape the signing page writes);
 *  - annual renewal: the amounts saved on the annual agreement (`annual_agreements.cost_summary`, written as "$1,250").
 *    The client's renewal agreement page shows those same amounts, so the screen says so before saving;
 *  - NEVER the signed PDF, an invoice already sent, or the company's own installment amounts (the June invoice uses those).
 *
 * Safety: both amounts are read with the same function the form uses (and refused rather than guessed); the write only
 * happens if nobody changed the record since the person opened it (the `updated_at` they saw is sent back and matched);
 * the old value, the new value and who changed it go to the audit log.
 */
import { supabaseAdmin } from '@/lib/supabase-admin'
import { formatAmount, parseAmountInput } from './amount-input'
import { buildContractUpdate, readContractAmounts } from './contract-amounts'
import { amountsText, currencySymbolOf, type OfferRow } from './entries'
import { loadSignedContractEntry } from './load'
import { applyRenewalAmounts, readRenewalAmounts } from './renewal-amounts'
import { AMOUNTS_CORRECTED_ACTION, type SignedContractEntry } from './types'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any

export type CorrectResult =
  // `entry` is null when the amounts were saved but the line could not be read back; `warning` then says so
  | { kind: 'ok'; entry: SignedContractEntry | null; warning?: string }
  | { kind: 'refused'; status: number; error: string }

const refuse = (status: number, error: string): CorrectResult => ({ kind: 'refused', status, error })

const CHANGED = 'These amounts were changed by someone else since you opened this page. Reload the page and look again before correcting them.'

export async function correctSignedContractAmounts(input: {
  contractId: string
  january: unknown
  june: unknown
  /** the `updatedAt` the person saw on the line */
  expectedUpdatedAt: string | null
  actor: { email: string; name: string }
}): Promise<CorrectResult> {
  const jan = parseAmountInput(input.january)
  if (jan.kind === 'refused') return refuse(422, `January: ${jan.error}`)
  const jun = parseAmountInput(input.june)
  if (jun.kind === 'refused') return refuse(422, `June: ${jun.error}`)

  const contractRes = await db.from('contracts').select('id, offer_token, updated_at, annual_fee, installments').eq('id', input.contractId).maybeSingle()
  if (contractRes.error) return refuse(500, `Could not read the contract: ${contractRes.error.message}`)
  const contract = contractRes.data as { id: string; offer_token: string; updated_at: string | null; annual_fee: string | null; installments: unknown } | null
  if (!contract) return refuse(404, 'This signed contract was not found.')

  const offerRes = await db.from('offers').select('id, token, contract_type, installment_currency, recurring_costs, account_id').eq('token', contract.offer_token).maybeSingle()
  if (offerRes.error) return refuse(500, `Could not read the offer of this contract: ${offerRes.error.message}`)
  const offer = offerRes.data as OfferRow | null
  if (!offer) return refuse(404, 'The offer of this contract was not found.')
  let symbol = currencySymbolOf(offer)
  const now = new Date().toISOString()
  const type = offer.contract_type

  let table: 'contracts' | 'annual_agreements'
  let recordId: string
  let wasText: string
  let wasValues: Record<string, unknown>
  let nowValues: Record<string, unknown>
  let accountId: string | null = offer.account_id

  if (type === 'formation' || type === 'onboarding') {
    table = 'contracts'
    recordId = contract.id
    const saved = readContractAmounts(contract.annual_fee, contract.installments)
    wasText = amountsText(saved.january, saved.june, symbol)
    wasValues = { annual_fee: contract.annual_fee, installments: contract.installments }
    const update = buildContractUpdate(jan.value, jun.value)
    nowValues = update
    let q = db.from('contracts').update({ ...update, updated_at: now }).eq('id', contract.id)
    q = input.expectedUpdatedAt == null ? q.is('updated_at', null) : q.eq('updated_at', input.expectedUpdatedAt)
    const res = await q.select('id')
    if (res.error) return refuse(500, `Could not save the correction: ${res.error.message}`)
    if (!res.data || res.data.length === 0) return refuse(409, CHANGED)
  } else if (type === 'renewal') {
    table = 'annual_agreements'
    const agRes = await db.from('annual_agreements').select('id, token, account_id, updated_at, cost_summary').eq('token', contract.offer_token).maybeSingle()
    if (agRes.error) return refuse(500, `Could not read the annual agreement of this contract: ${agRes.error.message}`)
    const ag =agRes.data as { id: string; token: string; account_id: string | null; updated_at: string | null; cost_summary: unknown } | null
    if (!ag) return refuse(404, 'The annual agreement of this contract was not found.')
    recordId = ag.id
    accountId = ag.account_id ?? accountId
    const read = readRenewalAmounts(ag.cost_summary)
    const written = (read.january ?? '').trim().charAt(0)
    if (written === '$' || written === '€') symbol = written // the agreement's own text says which currency it was written in
    const next = applyRenewalAmounts(ag.cost_summary, jan.value, jun.value)
    if (!next) return refuse(409, 'The amounts of this annual agreement are laid out in a way that cannot be edited here.')
    wasText = `January ${read.january ?? 'nothing saved'} · June ${read.june ?? 'nothing saved'}`
    wasValues = { cost_summary: ag.cost_summary }
    nowValues = { cost_summary: next }
    let q = db.from('annual_agreements').update({ cost_summary: next, updated_at: now }).eq('id', ag.id)
    q = input.expectedUpdatedAt == null ? q.is('updated_at', null) : q.eq('updated_at', input.expectedUpdatedAt)
    const res = await q.select('id')
    if (res.error) return refuse(500, `Could not save the correction: ${res.error.message}`)
    if (!res.data || res.data.length === 0) return refuse(409, CHANGED)
  } else {
    return refuse(409, 'This kind of contract has no installment amounts to correct.')
  }

  const nowText = `January ${formatAmount(jan.value, symbol)} · June ${formatAmount(jun.value, symbol)}`
  const warnings: string[] = []
  const logRow = {
    actor: 'crm-admin',
    action_type: AMOUNTS_CORRECTED_ACTION,
    table_name: table,
    record_id: contract.id, // the card finds a line's history by the signing record's id, for both kinds
    account_id: accountId,
    summary: `Installment amounts corrected on a signed ${type} contract (${contract.offer_token}): ${wasText} -> ${nowText}`,
    details: {
      offer_token: contract.offer_token,
      source: table,
      saved_in_record: recordId,
      was_text: wasText,
      now_text: nowText,
      was: wasValues,
      now: nowValues,
      by: input.actor.email,
      by_name: input.actor.name,
    },
  }
  const log = await db.from('action_log').insert(logRow)
  if (log.error) {
    // the old amount now exists nowhere else: keep all of it in the server log, and show it to the person who just changed it
    console.error('[signed-contracts] the audit log row could not be written:', log.error.message, JSON.stringify(logRow))
    warnings.push(`The amounts were saved, but the history line (who changed it, and the old value) could not be written. Before this correction it said: ${wasText}.`)
  }

  // the amounts are already saved: a failed read-back must never be reported as a failed save
  let entry: SignedContractEntry | null = null
  try {
    entry = await loadSignedContractEntry(contract.id)
  } catch (err) {
    console.error('[signed-contracts] the corrected line could not be read back:', err instanceof Error ? err.message : err)
  }
  if (!entry) warnings.push('The amounts were saved, but this line could not be refreshed. Reload the page before correcting it again.')
  return { kind: 'ok', entry, ...(warnings.length ? { warning: warnings.join(' ') } : {}) }
}
