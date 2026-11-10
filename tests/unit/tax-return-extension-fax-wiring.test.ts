/**
 * Tax Return plan item 7 (dev job 6f555c9f) — file the EXTENSION from the workspace: the data change on "1st Installment Paid", how the pieces are
 * wired together, the box's state route and the generate route. The rules are tested in extension-fax.test.ts, the delivery check in
 * extension-fax-delivery.test.ts, the form in form-7004-fill.test.ts, the purpose tag in fax-send-route-save-where.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const fx = vi.hoisted(() => ({
  staff: true,
  sd: null as Record<string, unknown> | null,
  account: null as Record<string, unknown> | null,
  docs: [] as Array<Record<string, unknown>>,
  latestFax: null as Record<string, unknown> | null,
  markers: [] as Array<Record<string, unknown>>,
  failMarker: false,
  fail: {} as Record<string, boolean>,
  saves: [] as Array<Record<string, unknown>>,
  saveRoute: 'store' as 'store' | 'drive',
  actionLogQueries: [] as string[],
}))

vi.mock('@/lib/supabase/server', () => ({ createClient: () => ({ auth: { getUser: async () => ({ data: { user: { id: 'user-1', email: 'luca@example.test' } } }) } }) }))
vi.mock('@/lib/auth', () => ({ isDashboardUser: () => fx.staff }))
vi.mock('@/lib/supabase-admin', () => ({
  supabaseAdmin: {
    from: (table: string) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const b: any = {}
      let single = false
      let markerKind: string | null = null
      const chain = () => b
      b.select = chain; b.in = chain; b.order = chain; b.limit = chain; b.ilike = chain
      b.eq = (col: string, val: string) => { if (col === 'action_type') markerKind = val; return b }
      const answer = () => {
        if (fx.fail[table]) return { data: null, error: { message: 'boom' } }
        if (table === 'service_deliveries') return { data: fx.sd, error: null }
        if (table === 'accounts') return { data: fx.account, error: null }
        if (table === 'documents') return { data: fx.docs, error: null }
        if (table === 'action_log') {
          if (single) return { data: fx.latestFax, error: null }
          if (markerKind && markerKind.startsWith('extension_fax_failed')) return { data: fx.failMarker ? [{ id: 'm1' }] : [], error: null }
          return { data: fx.markers, error: null }
        }
        return { data: null, error: null }
      }
      b.maybeSingle = () => { single = true; return Promise.resolve(answer()) }
      b.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(answer()).then(res, rej)
      return b
    },
  },
}))
vi.mock('@/lib/crm-store/save-for-account', () => {
  class CompanyMovingError extends Error {}
  return {
    CompanyMovingError,
    saveDocumentForAccount: async (input: Record<string, unknown>) => {
      fx.saves.push(input)
      return fx.saveRoute === 'store' ? { route: 'store', fileId: 'f-1', pointer: 'store:f-1', documentRowId: 'doc-9', status: 'created' } : { route: 'drive' }
    },
  }
})

import { GET } from '@/app/api/flows/[id]/extension-fax/route'
import { POST as GENERATE } from '@/app/api/flows/[id]/extension-fax/generate/route'
import { parseStageLayout, STAGE_COMPONENT_TYPES } from '@/lib/flows/stage-layout'
import { DEFAULT_EXTENSION_FAX_NUMBER, EXTENSION_FAX_PURPOSE } from '@/lib/fax/extension-fax'
import { SCHEDULED_CRONS } from '@/lib/cron-coverage'

const read = (rel: string) => readFileSync(join(__dirname, rel), 'utf8')
type Row = { stage_name: string; stage_order: number; stage_layout: unknown }
const ROWS = JSON.parse(read('../fixtures/pipeline-tax-return-stages.json')) as Row[]
const layoutOf = (stage: string) => parseStageLayout(ROWS.find((r) => r.stage_name === stage)!.stage_layout)!
const up = read('../../scripts/migrations/20261109-0200-tax-return-extension-fax-box.sql')
const undo = read('../../scripts/migrations/20261109-0200-tax-return-extension-fax-box.UNDO.sql')

describe('the data change on "1st Installment Paid" (migration + undo)', () => {
  it('shows the info panel, the extension box (carrying the old upload label) and the chat — in that order', () => {
    const comps = layoutOf('1st Installment Paid').components
    expect(comps.map((c) => c.type)).toEqual(['info_panel', 'extension_fax_panel', 'chat'])
    expect(comps[1].label).toBe('Upload Extension Receipt')
  })
  it('"Extension Filed" is untouched: its documents viewer shows the merged document, and the batch tool still moves old records there', () => {
    expect(layoutOf('Extension Filed').components.map((c) => c.type)).toEqual(['document_viewer', 'info_panel', 'action_buttons', 'chat'])
  })
  it('ONE guarded UPDATE: data only, fires only on the exact earlier layout, never inserts or deletes', () => {
    expect(up.match(/UPDATE pipeline_stages/g)).toHaveLength(1)
    expect(up).not.toMatch(/INSERT INTO|DELETE FROM|ALTER TABLE|CREATE /)
    expect(up).toContain("WHERE service_type = 'Tax Return' AND stage_name = '1st Installment Paid'")
    expect(up.match(/AND stage_layout = /g)).toHaveLength(1)
    expect(up).toContain('{"type": "document_upload", "label": "Upload Extension Receipt"}') // the guard still holds the OLD layout
  })
  it('the layout the UPDATE writes is exactly the dumped one', () => {
    const json = /SET stage_layout = '(\{[\s\S]*?\})'::jsonb/.exec(up)![1].replace(/''/g, "'")
    expect(ROWS.find((r) => r.stage_name === '1st Installment Paid')!.stage_layout).toEqual(JSON.parse(json))
  })
  it('the UNDO is the same swap the other way round, guarded the same way', () => {
    expect(undo.match(/UPDATE pipeline_stages/g)).toHaveLength(1)
    expect(undo).not.toMatch(/INSERT INTO|DELETE FROM/)
    const newJson = /SET stage_layout = '(\{[\s\S]*?\})'::jsonb/.exec(up)![1]
    const oldJson = /AND stage_layout = '(\{[\s\S]*?\})'::jsonb/.exec(up)![1]
    expect(undo).toContain(`SET stage_layout = '${oldJson}'::jsonb`)
    expect(undo).toContain(`AND stage_layout = '${newJson}'::jsonb`)
  })
  it('the layout engine knows the new box (and drops nothing else)', () => {
    expect(STAGE_COMPONENT_TYPES).toContain('extension_fax_panel')
    const parsed = parseStageLayout({ components: [{ type: 'extension_fax_panel' }, { type: 'bogus' }] })
    expect(parsed?.components.map((c) => c.type)).toEqual(['extension_fax_panel'])
  })
})

describe('how the pieces are wired', () => {
  it('the renderer shows the box and hands it the old upload box\'s settings (the plain box is its fallback)', () => {
    const renderer = read('../../components/flows/stage-renderer.tsx')
    expect(renderer).toContain("case 'extension_fax_panel':")
    for (const prop of ['serviceDeliveryId={serviceDelivery.id}', 'flowStage={serviceDelivery.stage}', 'uploadLabel={component.label}', 'uploadAutoAdvance={component.autoAdvance}']) {
      expect(renderer).toContain(prop)
    }
  })
  it('the box sends through the SAME engine as the other fax boxes — once-only send id, repeat needs the confirm, the job id for the guard — and tags it', () => {
    const panel = read('../../components/flows/extension-fax-panel.tsx')
    expect(panel).toContain("fetch('/api/tools/fax/send'")
    for (const field of ['dedupe_service_delivery_id: serviceDeliveryId', 'service_delivery_id: serviceDeliveryId', 'confirm_resend: confirmResend', 'send_id: sendId.current', 'document_id: documentId', 'purpose: EXTENSION_FAX_PURPOSE']) {
      expect(panel).toContain(field)
    }
    expect(panel).toContain('createOnceGuard')
    expect(panel).toContain('res.status === 409 && body.already_faxed')
    // the box repeats the tag as a plain string (the library module pulls server code in): the two must never drift
    expect(panel).toContain(`const EXTENSION_FAX_PURPOSE = '${EXTENSION_FAX_PURPOSE}'`)
  })
  it('the box refuses an IRS EIN (SS-4) line, names the company, the file and the number in the confirm window, and warns about a number that is not the last one used', () => {
    const panel = read('../../components/flows/extension-fax-panel.tsx')
    expect(panel).toContain('isIrsEinFaxNumber(faxno)')
    expect(panel).toContain('disabled={!faxno.trim() || einLine}')
    expect(panel).toContain('{data.company}')
    expect(panel).toContain('prettyNumber(faxno)')
    expect(panel).toContain('differentNumber')
  })
  it('the number is an editable field, never fixed in the box: the IRS can change it', () => {
    const panel = read('../../components/flows/extension-fax-panel.tsx')
    expect(panel).toContain('onChange={(e) => setFaxno(e.target.value)}')
    // the box starts from what the server says (the last delivered number, else the IRS number) — never from a number written into the box
    expect(panel).toContain('setFaxno((cur) => cur || body.fax_number)')
    expect(panel).not.toMatch(/useState\(['"]\d{10}/)
    expect(panel).not.toMatch(/faxno\s*[:=]\s*['"`]\d{10}/)
    expect(DEFAULT_EXTENSION_FAX_NUMBER).toBe('8558877737')
  })
  it('the delivery check runs every 10 minutes, registered where Vercel and the coverage audit read it', () => {
    expect(JSON.parse(read('../../vercel.json')).crons).toContainEqual({ path: '/api/cron/extension-fax-confirm', schedule: '*/10 * * * *' })
    expect(SCHEDULED_CRONS['/api/cron/extension-fax-confirm']).toBe('*/10 * * * *')
  })
  it('the documents are saved with NO actor id (the storage records a person\'s id and refuses a word like "system") and the move skips the generic stage notice', () => {
    const src = read('../../lib/fax/extension-fax-delivery.ts')
    const call = src.slice(src.indexOf('saveDocumentForAccount({'), src.indexOf('row: { document_type_name'))
    expect(call).toContain('actor: null')
    expect(call).not.toContain("actor: 'system'")
    expect(src).toContain('skip_notify: true')
    expect(src).toContain("actor: 'extension-fax-delivered'")
  })
  it('the cron reads the extension faxes from the fax history (only extension-tagged rows), skips confirmed ones, and logs every run; "Check now" runs the same check', () => {
    const cron = read('../../app/api/cron/extension-fax-confirm/route.ts')
    expect(cron).toContain(".eq('details->>purpose', EXTENSION_FAX_PURPOSE)")
    expect(cron).toContain('EXTENSION_FAX_MARKERS.confirmed')
    expect(cron).toContain('processExtensionFaxDelivery')
    expect(cron).toContain('logCron(')
    expect(read('../../app/api/flows/[id]/extension-fax/check/route.ts')).toContain('processExtensionFaxDelivery(params.id, await realExtensionFaxDeps())')
  })
  it('the SIGNED-RETURN fax box and its delivery check ignore extension faxes (a 7004 fax must never be taken for the return, nor file it)', () => {
    // "no purpose, or a purpose other than the extension one" (a row with NO purpose must stay in: SQL's != would drop it)
    const filter = /details->>purpose\.is\.null,details->>purpose\.neq\.\$\{EXTENSION_FAX_PURPOSE\}/
    expect(read('../../app/api/flows/[id]/return-fax/route.ts')).toMatch(filter)
    expect(read('../../lib/fax/return-fax-delivery.ts')).toMatch(filter)
    expect(read('../../app/api/tools/fax/send/route.ts')).toMatch(filter)
  })
  it('the 7004 template is a public static file, so a deployment that does not carry it in the function can still fetch it', () => {
    const f = read('../../lib/pdf/7004-fill.ts')
    expect(f).toContain('public", "templates", "f7004-blank.pdf"')
    expect(f).toContain('/templates/f7004-blank.pdf')
  })
})

// the clock matters now (a Form 7004 after the return's original due date is late): tests that care set it, and it is always put back
const setToday = (iso: string) => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(`${iso}T15:00:00Z`)) }
afterEach(() => { vi.useRealTimers() })

const call = async () => GET({} as never, { params: { id: 'sd-1' } })
const json = async () => (await call()).json()

describe('GET /api/flows/[id]/extension-fax — the box\'s state', () => {
  beforeEach(() => {
    fx.staff = true
    fx.sd = { id: 'sd-1', account_id: 'acc-1', service_type: 'Tax Return', service_name: 'Tax Return 2025 - Acme LLC', due_date: null, created_at: '2026-01-10T00:00:00Z', stage_entered_at: '2026-02-01T00:00:00Z' }
    fx.account = { company_name: 'Acme LLC', entity_type: 'Single Member LLC', ein_number: '12-3456789', suite_number: '3D-318', mailing_address: null }
    fx.docs = []; fx.latestFax = null; fx.markers = []; fx.fail = {}
  })

  it('staff only', async () => {
    fx.staff = false
    expect((await call()).status).toBe(403)
  })
  it('only a Tax Return job; an unknown job is a 404', async () => {
    fx.sd = { ...fx.sd, service_type: 'ITIN' }
    expect((await call()).status).toBe(400)
    fx.sd = null
    expect((await call()).status).toBe(404)
  })
  it('a single-member company with nothing generated → generate, with the form pre-filled (name, EIN, the OFFICIAL address from the suite number — no box number —, the tax year from the job name) and the IRS number', async () => {
    const body = await json()
    expect(body).toMatchObject({
      success: true, company: 'Acme LLC', year: 2025, account_id: 'acc-1', fax_number: DEFAULT_EXTENSION_FAX_NUMBER,
      default_reason: 'Form 7004 extension 2025 - Acme LLC',
      state: { mode: 'generate' },
      prefill: { companyName: 'Acme LLC', ein: '12-3456789', street: '10225 Ulmerton Rd 3D', suite: '', city: 'Largo', state: 'FL', zip: '33771', taxYear: 2025 },
    })
  })
  it('the address is the same official one whether or not a lease ran: the shared Largo row most companies have saved gives the same answer, no second style', async () => {
    const withoutRow = (await json()).prefill
    fx.account = { ...fx.account, mailing_address: { address_line1: '10225 Ulmerton Rd', address_line2: '3D', city: 'Largo', state: 'FL', zip: '33771' } }
    expect((await json()).prefill).toEqual(withoutRow)
  })
  it('a company with no TD number never gets the shared Largo row as its address; its own saved address is used', async () => {
    fx.account = { ...fx.account, suite_number: null, mailing_address: { address_line1: '10225 Ulmerton Rd', address_line2: '3D', city: 'Largo', state: 'FL', zip: '33771' } }
    expect((await json()).prefill).toMatchObject({ street: '', city: '', zip: '' })
    fx.account = { ...fx.account, mailing_address: { address_line1: '1 Main St', address_line2: null, city: 'Austin', state: 'TX', zip: '78701' } }
    expect((await json()).prefill).toMatchObject({ street: '1 Main St', city: 'Austin', state: 'TX', zip: '78701' })
  })
  it('the box is told the return\'s original due date and whether it has passed (New York date): the day itself is still on time', async () => {
    setToday('2026-04-15')
    expect(await json()).toMatchObject({ original_due_date: '2026-04-15', past_due: false, known_irs_number: DEFAULT_EXTENSION_FAX_NUMBER })
    setToday('2026-04-16')
    expect((await json()).past_due).toBe(true)
  })
  it('delivered to a number nobody confirmed → the box asks "was that the IRS?"; once confirmed it is back to waiting for the check', async () => {
    fx.latestFax = { id: 'l1', action_type: 'fax_sent', created_at: '2026-11-09T10:00:00Z', details: { job_id: '555', faxno: '8005550199', purpose: EXTENSION_FAX_PURPOSE } }
    fx.markers = [{ action_type: 'extension_fax_recipient_unverified', created_at: '2026-11-09T10:20:00Z', details: { job_id: '555', faxno: '8005550199' } }]
    expect((await json()).state).toMatchObject({ mode: 'confirm_recipient', faxJobId: '555', faxno: '8005550199' })
    fx.markers = [...fx.markers, { action_type: 'extension_fax_recipient_ok', created_at: '2026-11-09T10:30:00Z', details: { job_id: '555' } }]
    expect((await json()).state.mode).toBe('sent')
  })
  it('the filing-claim bookkeeping rows are left out of the markers the state reads (they could crowd real markers out of the newest 20)', () => {
    expect(read('../../app/api/flows/[id]/extension-fax/route.ts')).toContain('filter((k) => k !== EXTENSION_FAX_MARKERS.filingClaim)')
  })
  it('a generated 7004 → ready; a fax on record → sent (never "ready"); the confirmed marker → delivered', async () => {
    fx.docs = [{ id: 'doc-1', file_name: 'Form 7004 (as faxed) - Acme LLC - Tax Return 2025.pdf', drive_file_id: 'store:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', created_at: '2026-11-09T09:00:00Z' }]
    expect((await json()).state).toMatchObject({ mode: 'ready', documentId: 'doc-1' })
    fx.latestFax = { id: 'l1', action_type: 'fax_sent', created_at: '2026-11-09T10:00:00Z', details: { job_id: '555', faxno: '8558877737', purpose: EXTENSION_FAX_PURPOSE } }
    expect((await json()).state).toMatchObject({ mode: 'sent', faxJobId: '555' })
    fx.markers = [{ action_type: 'extension_fax_confirmed', created_at: '2026-11-09T10:20:00Z', details: { job_id: '555', faxno: '8001112222' } }]
    const body = await json()
    expect(body.state.mode).toBe('delivered')
    expect(body.fax_number).toBe('8001112222') // the number the last delivered extension fax went to, not a fixed one
  })
  it('a multi-member company → manual (the plain upload box), whatever else is on record', async () => {
    fx.account = { ...fx.account, entity_type: 'Multi Member LLC' }
    expect((await json()).state.mode).toBe('manual')
  })
  it('FAILS CLOSED: any lookup that fails is a 503 "nothing was sent", never "nothing was faxed"', async () => {
    for (const table of ['service_deliveries', 'accounts', 'documents', 'action_log']) {
      fx.fail = { [table]: true }
      const res = await call()
      expect(res.status, table).toBe(503)
      expect((await res.json()).success).toBe(false)
    }
  })
})

describe('POST /api/flows/[id]/extension-fax/generate — make the Form 7004', () => {
  const valid = { companyName: 'Acme LLC', ein: '12-3456789', street: '10225 Ulmerton Rd 3D', suite: '', city: 'Largo', state: 'FL', zip: '33771', taxYear: 2025, generate_id: 'gen-0000-0001' }
  const generate = (body: Record<string, unknown> = valid) => GENERATE({ json: async () => body } as never, { params: { id: 'sd-1' } })
  beforeEach(() => {
    setToday('2026-03-01') // before the 2025 return's original due date (April 15, 2026)
    fx.staff = true
    fx.sd = { id: 'sd-1', account_id: 'acc-1', service_type: 'Tax Return', service_name: 'Tax Return 2025 - Acme LLC', stage: '1st Installment Paid', status: 'active', due_date: null, created_at: '2026-01-10T00:00:00Z', stage_entered_at: '2026-02-01T00:00:00Z' }
    fx.account = { company_name: 'Acme LLC', entity_type: 'Single Member LLC' }
    fx.latestFax = null; fx.failMarker = false; fx.fail = {}; fx.saves.length = 0; fx.saveRoute = 'store'
  })

  it('staff only', async () => {
    fx.staff = false
    expect((await generate()).status).toBe(403)
  })
  it('saves the official form as the job\'s WORKING COPY: Tax folder, type Form 7004, hidden from the client, stamped with the job, saved by the person who pressed the button', async () => {
    const res = await generate()
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ success: true, document_id: 'doc-9', file_name: 'Form 7004 (as faxed) - Acme LLC - Tax Return 2025.pdf' })
    expect(fx.saves).toHaveLength(1)
    expect(fx.saves[0]).toMatchObject({
      accountId: 'acc-1', name: 'Form 7004 (as faxed) - Acme LLC - Tax Return 2025.pdf', folder: 'tax', documentType: 'form_7004',
      callerKey: 'extension-7004-working:sd-1:gen-0000-0001', portalVisible: false, periodYear: 2025, actor: 'user-1', mimeType: 'application/pdf',
      row: { document_type_name: 'Form 7004', service_delivery_id: 'sd-1', flow_stage: '1st Installment Paid' },
    })
    const bytes = fx.saves[0].bytes as Buffer
    expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-')
  })
  it('AFTER the return\'s original due date a Form 7004 is late: refused with a plain sentence until staff confirm it on purpose — nothing is made by accident', async () => {
    setToday('2026-11-10')
    const res = await generate()
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body).toMatchObject({ success: false, late: true })
    expect(body.error).toContain('April 15, 2026')
    expect(body.error).toContain('late')
    expect(fx.saves).toEqual([])
    // confirm_late must be exactly true (a truthy string is not a confirmation)
    expect((await generate({ ...valid, confirm_late: 'yes' })).status).toBe(409)
    expect(fx.saves).toEqual([])
    expect((await generate({ ...valid, confirm_late: true })).status).toBe(200)
    expect(fx.saves).toHaveLength(1)
  })
  it('the due date itself is still on time; the day after is late', async () => {
    setToday('2026-04-15')
    expect((await generate()).status).toBe(200)
    setToday('2026-04-16')
    expect((await generate({ ...valid, generate_id: 'gen-0000-0002' })).status).toBe(409)
  })
  it('the lateness is judged by the JOB\'s tax year, not by a year typed in the form', async () => {
    setToday('2026-11-10')
    expect((await generate({ ...valid, taxYear: 2030 })).status).toBe(409)
  })
  it('data that cannot make a valid form is a 400 with a plain sentence and nothing is saved', async () => {
    const res = await generate({ ...valid, ein: '12' })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/EIN must be 9 digits/)
    expect((await generate({ ...valid, generate_id: 'x' })).status).toBe(400) // a missing/bad generate id
    expect(fx.saves).toEqual([])
  })
  it('only while the job waits at "1st Installment Paid", only for a single-member LLC, only for a job with a company', async () => {
    fx.sd = { ...fx.sd, stage: 'Signed' }
    expect((await generate()).status).toBe(409)
    fx.sd = { ...fx.sd, stage: '1st Installment Paid', status: 'cancelled' }
    expect((await generate()).status).toBe(409)
    fx.sd = { ...fx.sd, status: 'active', account_id: null }
    expect((await generate()).status).toBe(409)
    fx.sd = { ...fx.sd, account_id: 'acc-1' }
    fx.account = { company_name: 'Acme LLC', entity_type: 'Multi Member LLC' }
    expect((await generate()).status).toBe(409)
    expect(fx.saves).toEqual([])
  })
  it('a fax already on record (or started and never confirmed) means the copy is what the IRS got: it is NOT replaced', async () => {
    fx.latestFax = { id: 'l1', action_type: 'fax_sent', created_at: '2026-11-09T10:00:00Z', details: { job_id: '555' } }
    expect((await generate()).status).toBe(409)
    fx.latestFax = { id: 'l2', action_type: 'fax_claim', created_at: '2026-11-09T10:00:00Z', details: {} }
    expect((await generate()).status).toBe(409)
    expect(fx.saves).toEqual([])
  })
  it('… but a fax that FAILED may be corrected and generated again', async () => {
    fx.latestFax = { id: 'l1', action_type: 'fax_sent', created_at: '2026-11-09T10:00:00Z', details: { job_id: '555' } }
    fx.failMarker = true
    expect((await generate()).status).toBe(200)
    expect(fx.saves).toHaveLength(1)
  })
  it('a company with no storage is told so, plainly, and nothing is claimed as made', async () => {
    fx.saveRoute = 'drive'
    const res = await generate()
    expect(res.status).toBe(409)
    expect((await res.json()).error).toMatch(/no storage/)
  })
  it('FAILS CLOSED: a lookup that fails is a 503 and nothing is made', async () => {
    for (const table of ['service_deliveries', 'accounts', 'action_log']) {
      fx.fail = { [table]: true }
      expect((await generate()).status, table).toBe(503)
    }
    expect(fx.saves).toEqual([])
  })
})
