/**
 * The real storage-place check, with only its two data sources faked, through each of the four generators.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('server-only', () => ({}))
const generated = vi.fn()
const ensurePersonOwner = vi.fn(async (..._a: unknown[]) => 'owner-new')
let companyState = 'switched'
let liveOwner: string | null = null
vi.mock('@/lib/crm-store/switched-drive-guard', () => ({
  companyDocState: async () => companyState,
  liveOwnerOfContact: async () => liveOwner,
}))
vi.mock('@/lib/crm-store/formation-pilot', () => ({ ensurePersonOwner: (...a: unknown[]) => ensurePersonOwner(...a), raisePilotAlarm: vi.fn() }))

let sub: Record<string, unknown> | null = null
let acct: Record<string, unknown> | null = null
let cases: Array<{ id: string }> = [{ id: 'sd1' }]
function chain(result: () => unknown, rows: () => unknown[] = () => []) {
  const c: Record<string, unknown> = {}
  for (const m of ['select', 'eq', 'in', 'is', 'or', 'order', 'limit', 'update', 'insert', 'not']) c[m] = () => c
  c.single = async () => ({ data: result(), error: null })
  c.maybeSingle = async () => ({ data: result(), error: null })
  c.then = (res: (v: unknown) => unknown) => res({ data: rows(), error: null })
  return c
}
vi.mock('@/lib/supabase-admin', () => ({
  supabaseAdmin: { from: (t: string) => chain(() => (t === 'itin_submissions' ? sub : t === 'accounts' ? acct : null), () => (t === 'service_deliveries' ? cases : [])), storage: { from: vi.fn() } },
}))
vi.mock('@/lib/crm-store/itin-applicant', async (orig) => {
  const real = await orig<typeof import('@/lib/crm-store/itin-applicant')>()
  return { ...real, realItinApplicantDeps: async () => ({
    linkedContacts: async () => [{ id: 'c-ann', full_name: 'Ann Lee', email: 'ann@x.com' }, { id: 'c-bob', full_name: 'Bob Roe', email: 'bob@x.com' }],
    contact: async () => null,
  }) }
})
let stopAfterPlace = true
const saved: Array<Record<string, unknown>> = []
vi.mock('@/lib/crm-store/save-for-account', () => ({
  saveDocumentForContact: async (input: Record<string, unknown>) => { saved.push(input); return { route: 'store', pointer: `store:${saved.length}`, fileId: `f${saved.length}`, documentRowId: `r${saved.length}` } },
}))
vi.mock('@/lib/pdf/w7-fill', () => ({ fillW7: () => { generated('w7'); if (stopAfterPlace) throw new Error('STOP-after-place'); return new Uint8Array(3) } }))
vi.mock('@/lib/pdf/1040nr-fill', () => ({ fill1040NR: () => new Uint8Array(3), fillScheduleOI: () => new Uint8Array(3) }))
vi.mock('@/lib/tax/financials-orchestration', () => ({ buildFinancialsWorkbookForAccount: () => { generated('pnl'); return null }, getAccountOwnershipProblem: async () => null }))
vi.mock('@/lib/harbor-compliance', () => ({ harborCompliance: { getDelivery: () => { generated('hc'); return { data: null } }, downloadDeliveryFile: vi.fn() } }))
vi.mock('@/lib/google-drive', () => ({ downloadFileBinary: () => { generated('tpl'); throw new Error('no') }, listFolder: vi.fn(), findTaxFolder: vi.fn(), searchFiles: vi.fn(), getFileMetadata: vi.fn() }))

async function tools(file: string, fn: string) {
  const handlers: Record<string, (a: never) => Promise<{ content: { text: string }[] }>> = {}
  const server = { tool: (name: string, _d: string, _s: unknown, h: never) => { handlers[name] = h } } as never
  const mod = await import(/* @vite-ignore */ `@/lib/mcp/tools/${file}`)
  mod[fn](server)
  return handlers
}
const text = (r: { content: { text: string }[] }) => r.content.map((c) => c.text).join('\n')
const ACC = '00000000-0000-0000-0000-000000000001'

beforeEach(() => { saved.length = 0; stopAfterPlace = true; cases = [{ id: 'sd1' }]; generated.mockClear(); ensurePersonOwner.mockClear(); companyState = 'switched'; liveOwner = null; sub = null; acct = null })

describe('Drive-only company (REBIS / YBR / Degasper / Fresh Legal shape): refused in plain words, nothing generated', () => {
  beforeEach(() => { companyState = 'drive' })

  it('closure_prepare_documents', async () => {
    acct = { company_name: 'Test Company LLC', ein_number: '1', state_of_formation: 'Wyoming', formation_date: '2020-01-01', drive_folder_id: 'x' }
    const out = text(await (await tools('closure', 'registerClosureTools'))['closure_prepare_documents']({ account_id: ACC } as never))
    expect(out).toMatch(/no storage place yet.*(set up its storage|by hand)/i)
    expect(generated).not.toHaveBeenCalled()
  })
  it('bank_statement_pnl (save_to_storage true)', async () => {
    const out = text(await (await tools('bank-statements', 'registerBankStatementTools'))['bank_statement_pnl']({ account_id: ACC, tax_year: 2025, save_to_storage: true, notify_client: false } as never))
    expect(out).toMatch(/no storage place yet/i)
    expect(generated).not.toHaveBeenCalled()
  })
  it('bank_statement_pnl with save_to_storage=false is NOT refused for lack of storage (the numbers still come back)', async () => {
    const out = text(await (await tools('bank-statements', 'registerBankStatementTools'))['bank_statement_pnl']({ account_id: ACC, tax_year: 2025, save_to_storage: false, notify_client: false } as never))
    expect(out).not.toMatch(/no storage place yet/i)
  })
  it('hc_download_delivery', async () => {
    acct = { id: 'a1', company_name: 'Test Company LLC' }
    const out = text(await (await tools('harbor-compliance', 'registerHarborComplianceTools'))['hc_download_delivery']({ delivery_id: 'd', account_id: ACC } as never))
    expect(out).toMatch(/no storage place yet/i)
    expect(generated).not.toHaveBeenCalled()
  })
})

describe('itin_prepare_documents — MMLLC with two members', () => {
  const mmllc = (email: string, linkedTo: string) => ({
    id: 's1', status: 'completed', contact_id: linkedTo, account_id: 'acct-mm', upload_paths: [],
    submitted_data: { first_name: 'Bob', last_name: 'Roe', email },
  })
  it('creates the storage for the member who filled the form, not the linked/first member', async () => {
    sub = mmllc('bob@x.com', 'c-ann')
    const out = text(await (await tools('itin-form', 'registerITINFormTools'))['itin_prepare_documents']({ token: 't', send_email: false } as never))
    expect(ensurePersonOwner).toHaveBeenCalledTimes(1)
    expect(ensurePersonOwner.mock.calls[0][0]).toBe('c-bob')
    expect(out).toMatch(/STOP-after-place/) // it went on to generate only AFTER the place existed
  })
  it('registers the three forms EXACTLY like the automatic path: on the open ITIN case, portal-visible, same key/type/category; folder named from the CRM name', async () => {
    stopAfterPlace = false
    sub = mmllc('bob@x.com', 'c-ann')
    const out = text(await (await tools('itin-form', 'registerITINFormTools'))['itin_prepare_documents']({ token: 't', send_email: false } as never))
    const forms = saved.filter((x) => (x.row as Record<string, unknown>).service_delivery_id)
    expect(forms).toHaveLength(3)
    for (const f of forms) {
      expect(f.contactId).toBe('c-bob')
      expect(f.portalVisible).toBe(true)
      expect(f.contactName).toBe('Bob Roe')
      expect(f.folderKind).toBe('itin')
      expect((f.row as Record<string, unknown>).category).toBe(3)
      expect(String(f.callerKey)).toMatch(/^itin-form-doc:c-bob:sd1:/)
    }
    expect(forms.map((f) => (f.row as Record<string, unknown>).document_type_name)).toEqual(['ITIN W-7', 'ITIN 1040-NR', 'ITIN Schedule OI'])
    expect(forms.map((f) => f.documentType)).toEqual(['form_w_7', 'form_1040_nr', 'itin_schedule_oi'])
    expect(out).not.toMatch(/Error/)
  })

  it('a Drive-only company: refused in one sentence, nothing generated, no storage created', async () => {
    companyState = 'drive'
    sub = mmllc('bob@x.com', 'c-ann')
    const out = text(await (await tools('itin-form', 'registerITINFormTools'))['itin_prepare_documents']({ token: 't', send_email: false } as never))
    expect(out).toMatch(/no storage place yet/i)
    expect(ensurePersonOwner).not.toHaveBeenCalled()
    expect(generated).not.toHaveBeenCalled()
  })

  it('Bob fills the form with his wife\'s email: refused, no storage for anyone, nothing generated', async () => {
    sub = mmllc('ann@x.com', 'c-ann')
    const out = text(await (await tools('itin-form', 'registerITINFormTools'))['itin_prepare_documents']({ token: 't', send_email: false } as never))
    expect(out).toMatch(/belongs to one member/i)
    expect(ensurePersonOwner).not.toHaveBeenCalled()
    expect(generated).not.toHaveBeenCalled()
  })

  it('refuses before generating when the person has no open ITIN case', async () => {
    cases = []
    sub = mmllc('bob@x.com', 'c-ann')
    const out = text(await (await tools('itin-form', 'registerITINFormTools'))['itin_prepare_documents']({ token: 't', send_email: false } as never))
    expect(out).toMatch(/no open ITIN case/i)
    expect(ensurePersonOwner).not.toHaveBeenCalled() // a refusal leaves no empty storage behind
    expect(generated).not.toHaveBeenCalled()
    expect(saved).toHaveLength(0)
  })

  it('refuses when the applicant cannot be told, and creates no storage for anyone', async () => {
    sub = mmllc('nobody@z.com', '')
    sub.contact_id = null
    sub.submitted_data = { first_name: 'Cy', last_name: 'Dee', email: 'nobody@z.com' }
    const out = text(await (await tools('itin-form', 'registerITINFormTools'))['itin_prepare_documents']({ token: 't', send_email: false } as never))
    expect(out).toMatch(/which person/i)
    expect(ensurePersonOwner).not.toHaveBeenCalled()
    expect(generated).not.toHaveBeenCalled()
  })
})

describe('a REMOVED parameter is never silently ignored', () => {
  it('bank_statement_pnl({ upload_to_drive:false }) errors and names save_to_storage (it must not save)', async () => {
    const out = text(await (await tools('bank-statements', 'registerBankStatementTools'))['bank_statement_pnl']({ account_id: ACC, tax_year: 2025, upload_to_drive: false } as never))
    expect(out).toMatch(/upload_to_drive was removed.*save_to_storage/)
    expect(generated).not.toHaveBeenCalled()
    expect(ensurePersonOwner).not.toHaveBeenCalled()
  })
  it('itin_prepare_documents({ drive_folder_id }) errors and generates nothing', async () => {
    const out = text(await (await tools('itin-form', 'registerITINFormTools'))['itin_prepare_documents']({ token: 't', send_email: false, drive_folder_id: 'f' } as never))
    expect(out).toMatch(/drive_folder_id was removed/)
    expect(generated).not.toHaveBeenCalled()
  })
  it('gmail_read_attachment({ save_to_drive_folder_id }) errors and names save_to_account_id', async () => {
    const out = text(await (await tools('gmail', 'registerGmailTools'))['gmail_read_attachment']({ message_id: 'm', save_to_drive_folder_id: 'f' } as never))
    expect(out).toMatch(/save_to_drive_folder_id was removed.*save_to_account_id/)
  })
})
