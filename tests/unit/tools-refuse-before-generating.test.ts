/**
 * Stop Drive S1b fix round: a tool that makes a document decides where it will be saved BEFORE making it.
 * With no storage place it refuses in one sentence, generates nothing, and never prints a success line.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('server-only', () => ({}))

const generated = vi.fn()
let sub: Record<string, unknown> | null = null
let acct: Record<string, unknown> | null = null

function chain(result: () => unknown) {
  const c: Record<string, unknown> = {}
  for (const m of ['select', 'eq', 'in', 'is', 'order', 'limit', 'update', 'insert', 'not', 'gte', 'lte']) c[m] = () => c
  c.single = async () => ({ data: result(), error: null })
  c.maybeSingle = async () => ({ data: result(), error: null })
  c.then = (res: (v: unknown) => unknown) => res({ data: [], error: null })
  return c
}
vi.mock('@/lib/supabase-admin', () => ({
  supabaseAdmin: { from: (t: string) => chain(() => (t === 'itin_submissions' ? sub : t === 'accounts' ? acct : null)), storage: { from: vi.fn() } },
}))
vi.mock('@/lib/pdf/w7-fill', () => ({ fillW7: (...a: unknown[]) => { generated('w7', a); return new Uint8Array(1) } }))
vi.mock('@/lib/pdf/1040nr-fill', () => ({ fill1040NR: () => { generated('nr'); return new Uint8Array(1) }, fillScheduleOI: () => { generated('oi'); return new Uint8Array(1) } }))
vi.mock('@/lib/tax/financials-orchestration', () => ({
  buildFinancialsWorkbookForAccount: (...a: unknown[]) => { generated('pnl', a); return null },
  getAccountOwnershipProblem: async () => null,
}))
vi.mock('@/lib/harbor-compliance', () => ({ harborCompliance: { getDelivery: (...a: unknown[]) => { generated('hc-get', a); return { data: null } }, downloadDeliveryFile: vi.fn() } }))
vi.mock('@/lib/google-drive', () => ({ downloadFileBinary: (...a: unknown[]) => { generated('tpl', a); throw new Error('no') }, listFolder: vi.fn(), findTaxFolder: vi.fn(), searchFiles: vi.fn(), getFileMetadata: vi.fn() }))

let companyOk = true
let personOk = true
vi.mock('@/lib/crm-store/storage-place', () => ({
  companyStoragePlace: async () => (companyOk ? { ok: true, message: '' } : { ok: false, message: 'This company has no storage place yet. Nothing was generated.' }),
  personStoragePlace: async (c: string | null) => (personOk && c ? { ok: true, message: '' } : { ok: false, message: 'This form is not linked to a person yet. Nothing was generated.' }),
}))

async function tools(file: string, fn: string) {
  const handlers: Record<string, (a: never) => Promise<{ content: { text: string }[] }>> = {}
  const server = { tool: (name: string, _d: string, _s: unknown, h: never) => { handlers[name] = h } } as never
  const mod = await import(/* @vite-ignore */ `@/lib/mcp/tools/${file}`)
  mod[fn](server)
  return handlers
}
const text = (r: { content: { text: string }[] }) => r.content.map((c) => c.text).join('\n')

beforeEach(() => { generated.mockClear(); companyOk = true; personOk = true; sub = null; acct = null })

describe('refuse up front, generate nothing, claim nothing', () => {
  it('itin_prepare_documents: a form with no contact is refused before any PDF is made', async () => {
    sub = { id: 's1', status: 'completed', contact_id: null, account_id: null, submitted_data: { first_name: 'Ann', last_name: 'Lee' }, upload_paths: [] }
    const h = await tools('itin-form', 'registerITINFormTools')
    const out = text(await h['itin_prepare_documents']({ token: 't', send_email: false } as never))
    expect(out).toMatch(/which person/i)
    expect(out).not.toMatch(/saved in storage|generated, saved/i)
    expect(generated).not.toHaveBeenCalled()
  })

  it('closure_prepare_documents: a company with no storage place is refused before anything is generated', async () => {
    acct = { company_name: 'Test Company LLC', ein_number: '12-3456789', state_of_formation: 'Wyoming', formation_date: '2020-01-01', drive_folder_id: 'x' }
    companyOk = false
    const h = await tools('closure', 'registerClosureTools')
    const out = text(await h['closure_prepare_documents']({ account_id: '00000000-0000-0000-0000-000000000001' } as never))
    expect(out).toMatch(/no storage place yet/i)
    expect(out).not.toMatch(/✅|filled|generated\b.*saved/i)
    expect(generated).not.toHaveBeenCalled()
  })

  it('bank_statement_pnl: a company with no storage place is refused before the workbook is built', async () => {
    companyOk = false
    const h = await tools('bank-statements', 'registerBankStatementTools')
    const out = text(await h['bank_statement_pnl']({ account_id: '00000000-0000-0000-0000-000000000001', tax_year: 2025, save_to_storage: true, notify_client: false } as never))
    expect(out).toMatch(/no storage place yet/i)
    expect(out).not.toMatch(/P&L generated/)
    expect(generated).not.toHaveBeenCalled()
  })

  it('hc_download_delivery: a company with no storage place is refused before the delivery is fetched', async () => {
    acct = { id: 'a1', company_name: 'Test Company LLC' }
    companyOk = false
    const h = await tools('harbor-compliance', 'registerHarborComplianceTools')
    const out = text(await h['hc_download_delivery']({ delivery_id: 'd1', account_id: '00000000-0000-0000-0000-000000000001' } as never))
    expect(out).toMatch(/Not saved/i)
    expect(generated).not.toHaveBeenCalled()
  })
})
