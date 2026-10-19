/**
 * Stop Drive S1d: processOfferSigned — the signed contract's Drive branch, one real run per company state.
 * storage = storage (zero Drive calls) · left-on-Drive company = FROZEN (Stop Drive S2) · Closed / no folder = "error: …" + ONE alarm
 * (the result must stay an error — it used to be overwritten by a later "skipped").
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const st = vi.hoisted(() => ({
  rows: {} as Record<string, unknown>,
  insertResults: {} as Record<string, unknown>,
  recorded: [] as Array<{ table: string; op: string; payload: unknown }>,
  driveWrites: [] as string[],
  driveReads: [] as string[],
  companyState: 'drive' as 'drive' | 'store' | 'moving',
  saves: [] as Array<Record<string, unknown>>,
  alarms: [] as Array<{ kind: string; details: Record<string, unknown> }>,
}))
vi.mock('@/lib/supabase-admin', async () => ({ supabaseAdmin: (await import('./_legacy-drive-mocks')).makeSupabase(st.rows, st.recorded as never, st.insertResults) }))
vi.mock('@/lib/google-drive', async () => (await import('./_legacy-drive-mocks')).driveSpy(st.driveWrites, st.driveReads, { writesSucceed: true }))
vi.mock('@/lib/crm-store/switched-drive-guard', () => ({ companyDocState: async () => st.companyState }))
vi.mock('@/lib/crm-store/formation-pilot', () => ({ raisePilotAlarm: async (kind: string, details: Record<string, unknown>) => { st.alarms.push({ kind, details }) }, ensurePersonOwner: async () => 'p-owner' }))
vi.mock('@/lib/crm-store/save-for-account', () => ({
  saveSignedPdfForAccount: async (i: Record<string, unknown>) => { st.saves.push(i); return { route: 'store', fileId: 'f1', pointer: 'store:f1', documentRowId: 'd1', status: 'created' } },
  saveDocumentForContact: async () => ({ route: 'drive' }),
}))
vi.mock('@/lib/portal/auto-save-document', () => ({ autoSaveDocument: async () => ({ id: 'd' }) }))
vi.mock('@/lib/portal/td-invoice', () => ({ createTDInvoice: async () => ({ success: true, invoice_number: 'INV-000001' }) }))
vi.mock('@/lib/portal/chat-events', () => ({ emitOfferSignedEvent: async () => ({}) }))

beforeEach(async () => {
  ;(await import('@/lib/crm-store/legacy-drive')).forgetRecentAlarms()
  st.recorded.length = 0; st.driveWrites.length = 0; st.driveReads.length = 0; st.saves.length = 0; st.alarms.length = 0
  st.companyState = 'drive'
  for (const k of Object.keys(st.rows)) delete st.rows[k]
  st.insertResults.pending_activations = { id: 'act-1' }
  st.rows.offers = { id: 'o1', token: 'tok', status: 'signed', account_id: 'acc-1', contact_id: 'c1', lead_id: null, client_name: 'Acme', contract_type: 'tax_return', services: [], payment_links: [], bank_details: null, currency: 'USD', total: 0 }
  st.rows.contracts = { pdf_path: 'tok/contract.pdf' }
  st.rows.contacts = { id: 'c1', full_name: 'A B', email: 'a@b.co' }
})

const acct = (status: string, folder: string | null) => { st.rows.accounts = { status, drive_folder_id: folder, gdrive_folder_url: null } }

describe('processOfferSigned — the signed contract', () => {
  it('company in storage: saved in storage, zero Drive calls', async () => {
    st.companyState = 'store'; acct('Active', null)
    const { processOfferSigned } = await import('@/lib/offers/process-offer-signed')
    const r = await processOfferSigned('tok')
    expect(r.status).toBe(200)
    expect(String(r.body.drive_upload)).toMatch(/^ok: store:/)
    expect(st.driveWrites).toEqual([]); expect(st.driveReads).toEqual([])
  })
  it('left-on-Drive company (Offboarding, folder, no storage) is frozen (Stop Drive S2): an error result + ONE alarm, nothing written in Drive', async () => {
    acct('Offboarding', 'F-rebis')
    const { processOfferSigned } = await import('@/lib/offers/process-offer-signed')
    const r = await processOfferSigned('tok')
    expect(String(r.body.drive_upload)).toMatch(/^error: .*read-only/)
    expect(st.driveWrites).toEqual([])
    expect(st.alarms.map((a) => a.kind)).toEqual(['drive_write_refused'])
  })
  it.each([['Closed', 'F-old', /company is closed/], ['Cancelled', 'F-old', /company is closed/], ['Active', null, /no document storage/]] as const)('%s company (folder %s): "error: …" stays an error, nothing written in Drive, ONE alarm', async (status, folder, msg) => {
    acct(status, folder as string | null)
    const { processOfferSigned } = await import('@/lib/offers/process-offer-signed')
    const r = await processOfferSigned('tok')
    expect(r.status).toBe(200)
    expect(String(r.body.drive_upload)).toMatch(/^error: /)
    expect(String(r.body.drive_upload)).toMatch(msg)
    expect(st.driveWrites).toEqual([])
    expect(st.alarms.map((a) => a.kind)).toEqual(['drive_write_refused'])
  })
})
