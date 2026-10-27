/**
 * The SS-4 check on a fax (dev job ff2b73d7). Faxing the IRS is irreversible, so an SS-4 whose registered agent — or whose printed Line 6 —
 * is not in the client's company's own state must never go out (Tanto per: a New Mexico company faxed with "Sheridan County, Wyoming").
 *
 * WHEN IT APPLIES — only to a fax FOR A CLIENT'S COMPANY: the SS-4 panel, or an SS-4 sent to an IRS EIN fax line. A fax to anyone else
 * (a bank, an attorney, a client …) is never checked and never asks for a company; neither is a non-SS-4 document sent to the IRS.
 *
 * WHAT IT CHECKS, for an SS-4 that applies:
 *   1. the fax is tied to a client's company (the panel's case, the stored document's company, the company the file lives in, or the
 *      company staff chose in "Where should this be saved?") — otherwise it is refused with "choose the company";
 *   2. the company's records: the registered agent and the saved Line 6 are in the company's state (checkSs4StateGate);
 *   3. the FILE itself: the state printed on its Line 6 is the company's state (it blocks only on a positive reading — a file whose text
 *      cannot be read falls back to the records check).
 * No override. A check that cannot be completed refuses the send ("nothing was faxed"); it never passes.
 */
import { supabaseAdmin } from '@/lib/supabase-admin'
import { isIrsEinFaxNumber } from '@/lib/fax/irs-ein-numbers'
import { readSs4PdfFacts } from '@/lib/fax/ss4-pdf-facts'
import { checkSs4StateGate } from '@/lib/operations/ss4-state-gate'
import { STATE_NAMES } from '@/lib/formation/registered-agent-state'

const SS4_LOOKS_LIKE = /ss[-_ ]?4/i
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const CHOOSE_COMPANY_SENTENCE =
  'This looks like an SS-4 going to the IRS EIN line, so it has to be tied to the client\'s company — that is how its registered agent is checked against the company\'s state. ' +
  'Choose the company\'s folder in "Where should this be saved?", or send it from the company\'s SS-4 panel. Nothing was faxed.'

const READ_ERROR_SENTENCE = 'Could not check this SS-4 against its company. The fax was NOT sent. Please try again.'

export interface Ss4FaxInput {
  /** Normalized recipient number. */
  faxno: string
  /** The flow (service delivery) id when the SS-4 panel sent it (its double-send flag), else null. */
  panelServiceDeliveryId: string | null
  fileName: string
  bytes: Buffer
  /** The stored `documents` row when a document was picked. */
  documentRow: { account_id: string | null; document_type_name: string | null } | null
  /** The storage file when "Fax this file" was used. */
  storeFileId: string | null
  /** The company staff chose in "Where should this be saved?" (already validated). */
  chosenCompanyAccountId: string | null
}

export interface Ss4FaxVerdict {
  ok: boolean
  status?: number
  error?: string
}

export async function checkSs4Fax(input: Ss4FaxInput): Promise<Ss4FaxVerdict> {
  const fromPanel = !!input.panelServiceDeliveryId
  // A fax to anyone but an IRS EIN line is not for a client's company: never checked, never asks for anything.
  if (!fromPanel && !isIrsEinFaxNumber(input.faxno)) return { ok: true }

  const facts = await readSs4PdfFacts(input.bytes)
  const isSs4 = fromPanel || facts.isSs4 || SS4_LOOKS_LIKE.test(input.fileName) || SS4_LOOKS_LIKE.test(input.documentRow?.document_type_name ?? '')
  // an IRS fax that is not an SS-4 (a letter, a form 8832 …) has nothing to check
  if (!isSs4) return { ok: true }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabaseAdmin as any
  let accountId: string | null = null

  if (fromPanel) {
    const sd = await db.from('service_deliveries').select('account_id').eq('id', input.panelServiceDeliveryId).maybeSingle()
    if (sd.error) return { ok: false, status: 503, error: READ_ERROR_SENTENCE }
    accountId = (sd.data?.account_id as string | null | undefined) ?? null
  }
  if (!accountId) accountId = input.documentRow?.account_id ?? null
  if (!accountId && input.storeFileId && UUID.test(input.storeFileId)) {
    const f = await db.from('store_files').select('owner_id').eq('id', input.storeFileId).maybeSingle()
    if (f.error) return { ok: false, status: 503, error: READ_ERROR_SENTENCE }
    if (f.data?.owner_id) {
      const o = await db.from('store_owners').select('kind, account_id').eq('id', f.data.owner_id).maybeSingle()
      if (o.error) return { ok: false, status: 503, error: READ_ERROR_SENTENCE }
      if (o.data?.kind === 'company' && o.data.account_id) accountId = o.data.account_id as string
    }
  }
  if (!accountId) accountId = input.chosenCompanyAccountId
  if (!accountId) return { ok: false, status: 409, error: CHOOSE_COMPANY_SENTENCE }

  // the company's records
  const gate = await checkSs4StateGate(accountId, { context: 'fax' })
  if (!gate.ok) return { ok: false, status: gate.kind === 'read_error' ? 503 : 409, error: gate.message }

  // the file itself
  if (facts.isSs4 && facts.line6State && gate.companyState && facts.line6State !== gate.companyState) {
    const who = gate.companyName && gate.companyName.trim() ? gate.companyName.trim() : 'this company'
    return {
      ok: false,
      status: 409,
      error:
        `The SS-4 in this file shows ${STATE_NAMES[facts.line6State]} on Line 6 ("${facts.line6Text}"), but ${who} is formed in ${STATE_NAMES[gate.companyState]}. ` +
        'Nothing was faxed. The file is wrong or out of date — send the current signed SS-4 from the company\'s SS-4 panel (after "Re-send for Signature" if the SS-4 was changed).',
    }
  }
  return { ok: true }
}
