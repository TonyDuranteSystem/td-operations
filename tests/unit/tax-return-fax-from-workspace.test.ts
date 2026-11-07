/**
 * Tax Return plan item 6 (dev job 6f555c9f) — fax the signed return to the IRS FROM THE WORKSPACE: the data change on "Signed", how the pieces are
 * wired together, and the box's state route. The rules are tested in return-fax.test.ts, the delivery check in return-fax-delivery.test.ts, the
 * SS-4 check exemption in ss4-fax-gate.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const fx = vi.hoisted(() => ({
  staff: true,
  sd: null as Record<string, unknown> | null,
  account: null as Record<string, unknown> | null,
  envelopes: [] as Array<Record<string, unknown>>,
  docs: [] as Array<Record<string, unknown>>,
  latestFax: null as Record<string, unknown> | null,
  markers: [] as Array<Record<string, unknown>>,
  fail: {} as Record<string, boolean>,
}))

vi.mock('@/lib/supabase/server', () => ({ createClient: () => ({ auth: { getUser: async () => ({ data: { user: { email: 'luca@example.test' } } }) } }) }))
vi.mock('@/lib/auth', () => ({ isDashboardUser: () => fx.staff }))
vi.mock('@/lib/supabase-admin', () => ({
  supabaseAdmin: {
    from: (table: string) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const b: any = {}
      let single = false
      const chain = () => b
      b.select = chain; b.eq = chain; b.in = chain; b.order = chain; b.limit = chain
      const answer = () => {
        if (fx.fail[table]) return { data: null, error: { message: 'boom' } }
        if (table === 'service_deliveries') return { data: fx.sd, error: null }
        if (table === 'accounts') return { data: fx.account, error: null }
        if (table === 'esign_envelopes') return { data: fx.envelopes, error: null }
        if (table === 'documents') return { data: fx.docs, error: null }
        if (table === 'action_log') return single ? { data: fx.latestFax, error: null } : { data: fx.markers, error: null }
        return { data: null, error: null }
      }
      b.maybeSingle = () => { single = true; return Promise.resolve(answer()) }
      b.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(answer()).then(res, rej)
      return b
    },
  },
}))

import { GET } from '@/app/api/flows/[id]/return-fax/route'
import { parseStageLayout, STAGE_COMPONENT_TYPES } from '@/lib/flows/stage-layout'
import { NON_SS4_PANEL_SERVICE_TYPES } from '@/lib/fax/ss4-fax-gate'
import { IRS_RETURN_FAX_NUMBER } from '@/lib/fax/return-fax'
import { TAX_RETURN_SIGN_STAGES } from '@/lib/flows/tax-return-sign-stages'
import { SCHEDULED_CRONS } from '@/lib/cron-coverage'

const read = (rel: string) => readFileSync(join(__dirname, rel), 'utf8')
type Row = { stage_name: string; stage_order: number; stage_layout: unknown }
const ROWS = JSON.parse(read('../fixtures/pipeline-tax-return-stages.json')) as Row[]
const layoutOf = (stage: string) => parseStageLayout(ROWS.find((r) => r.stage_name === stage)!.stage_layout)!
const up = read('../../scripts/migrations/20261107-0100-tax-return-signed-fax-box.sql')
const undo = read('../../scripts/migrations/20261107-0100-tax-return-signed-fax-box.UNDO.sql')

describe('the data change on "Signed" (migration + undo)', () => {
  it('"Signed" shows the signed-copy status, the return fax box, the documents, File with IRS (the fallback) and the chat — in that order', () => {
    const comps = layoutOf('Signed').components
    expect(comps.map((c) => c.type)).toEqual(['esign_panel', 'return_fax_panel', 'document_viewer', 'action_buttons', 'chat'])
    const [b] = comps.find((c) => c.type === 'action_buttons')!.actions! as Array<{ key: string; target: string }>
    expect(b).toMatchObject({ key: 'file_with_irs', target: TAX_RETURN_SIGN_STAGES.filed })
  })
  it('the older "TR Completed" step keeps its plain fax link (old jobs, manual moves)', () => {
    expect(layoutOf('TR Completed').components.map((c) => c.type)).toContain('fax_irs')
  })
  it('ONE guarded UPDATE: data only, fires only on the exact item-5 layout, never inserts or deletes', () => {
    expect(up.match(/UPDATE pipeline_stages/g)).toHaveLength(1)
    expect(up).not.toMatch(/INSERT INTO|DELETE FROM|ALTER TABLE|CREATE /)
    expect(up).toContain("WHERE service_type = 'Tax Return' AND stage_name = 'Signed'")
    expect(up.match(/AND stage_layout = /g)).toHaveLength(1)
    expect(up).toContain('{"type": "fax_irs"}') // the guard still holds the OLD layout
  })
  it('the layout the UPDATE writes is exactly the dumped one', () => {
    const json = /SET stage_layout = '(\{[\s\S]*?\})'::jsonb/.exec(up)![1].replace(/''/g, "'")
    expect(ROWS.find((r) => r.stage_name === 'Signed')!.stage_layout).toEqual(JSON.parse(json))
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
    expect(STAGE_COMPONENT_TYPES).toContain('return_fax_panel')
    const parsed = parseStageLayout({ components: [{ type: 'return_fax_panel' }, { type: 'bogus' }] })
    expect(parsed?.components.map((c) => c.type)).toEqual(['return_fax_panel'])
  })
})

describe('how the pieces are wired', () => {
  it('the renderer shows the box with the account and the job type (the manual link needs both)', () => {
    const renderer = read('../../components/flows/stage-renderer.tsx')
    expect(renderer).toContain("case 'return_fax_panel':")
    expect(renderer).toContain('<ReturnFaxPanel key={key} serviceDeliveryId={serviceDelivery.id} account={account} serviceType={serviceDelivery.service_type} />')
  })
  it('the box sends through the SAME engine as the SS-4 box: once-only send id, repeat needs the confirm, the job id for the double-send guard', () => {
    const panel = read('../../components/flows/return-fax-panel.tsx')
    expect(panel).toContain("fetch('/api/tools/fax/send'")
    for (const field of ['dedupe_service_delivery_id: serviceDeliveryId', 'service_delivery_id: serviceDeliveryId', 'confirm_resend: confirmResend', 'send_id: sendId.current', 'document_id: documentId']) {
      expect(panel).toContain(field)
    }
    expect(panel).toContain('createOnceGuard')
    expect(panel).toContain('res.status === 409 && body.already_faxed')
  })
  it('the box refuses an IRS EIN (SS-4) line for a signed return, and the confirm window names the company, the file and the number', () => {
    const panel = read('../../components/flows/return-fax-panel.tsx')
    expect(panel).toContain('isIrsEinFaxNumber(faxno)')
    expect(panel).toContain('disabled={!faxno.trim() || einLine}')
    expect(panel).toContain('{data.company}')
    expect(panel).toContain('prettyNumber(faxno)')
  })
  it('only a Tax Return job is exempt from the SS-4 check (any other job type keeps failing closed)', () => {
    expect(NON_SS4_PANEL_SERVICE_TYPES.size).toBe(1)
    expect(NON_SS4_PANEL_SERVICE_TYPES.has('Tax Return')).toBe(true)
  })
  it('the delivery check runs every 10 minutes, registered where Vercel and the coverage audit read it', () => {
    expect(JSON.parse(read('../../vercel.json')).crons).toContainEqual({ path: '/api/cron/return-fax-confirm', schedule: '*/10 * * * *' })
    expect(SCHEDULED_CRONS['/api/cron/return-fax-confirm']).toBe('*/10 * * * *')
  })
  it('the receipt is saved with NO actor id: the storage records a person\'s id and refuses a word like "system" (found by the live sandbox run)', () => {
    const src = read('../../lib/fax/return-fax-delivery.ts')
    const call = src.slice(src.indexOf('saveDocumentForAccount({'), src.indexOf('row: { document_type_name'))
    expect(call).toContain('actor: null')
    expect(call).not.toContain("actor: 'system'")
  })
  it('the cron only looks at Tax Return jobs at "Signed" and skips cancelled ones; "Check now" runs the same check', () => {
    const cron = read('../../app/api/cron/return-fax-confirm/route.ts')
    expect(cron).toContain(".eq('service_type', 'Tax Return')")
    expect(cron).toContain('.eq(\'stage\', TAX_RETURN_SIGN_STAGES.signed)')
    expect(cron).toContain(".neq('status', 'cancelled')")
    expect(cron).toContain('processReturnFaxDelivery')
    expect(read('../../app/api/flows/[id]/return-fax/check/route.ts')).toContain('processReturnFaxDelivery(params.id, await realReturnFaxDeps())')
  })
})

describe('GET /api/flows/[id]/return-fax — the box\'s state', () => {
  const call = async () => GET({} as never, { params: { id: 'sd-1' } })
  const json = async () => (await call()).json()
  const signedCopy = () => {
    fx.envelopes = [{ id: 'env-1', status: 'completed', completed_at: '2026-11-06T22:52:23Z', signed_pdf_drive_id: 'store:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', document_name: 'Tax Return 2025 - Acme LLC' }]
    fx.docs = [{ id: 'doc-1', file_name: 'Tax Return 2025 - Acme LLC - Signed.pdf', drive_file_id: 'store:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }]
  }
  beforeEach(() => {
    fx.staff = true
    fx.sd = { id: 'sd-1', account_id: 'acc-1', service_type: 'Tax Return', service_name: 'Tax Return 2025 - Acme LLC', due_date: null, created_at: '2026-08-01T00:00:00Z', stage_entered_at: '2026-11-06T22:52:27Z' }
    fx.account = { company_name: 'Acme LLC', entity_type: 'Single Member LLC' }
    fx.envelopes = []; fx.docs = []; fx.latestFax = null; fx.markers = []; fx.fail = {}
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
  it('a single-member company with a signed copy → ready, with the number, reason and cover note pre-filled and the year read from the job name', async () => {
    signedCopy()
    const body = await json()
    expect(body).toMatchObject({
      success: true, company: 'Acme LLC', year: 2025, account_id: 'acc-1', irs_number: IRS_RETURN_FAX_NUMBER,
      default_reason: 'Tax Return 2025 filing - Acme LLC', default_cover: 'Signed tax return 2025 for Acme LLC.',
      state: { mode: 'ready', documentId: 'doc-1' },
    })
  })
  it('a multi-member company → the manual card, whatever else is on record', async () => {
    signedCopy()
    fx.account = { company_name: 'Acme LLC', entity_type: 'Multi Member LLC' }
    expect((await json()).state.mode).toBe('manual')
  })
  it('a job with no signed document → no_copy; a fax on record → sent (and never "ready"); the delivery marker → delivered', async () => {
    expect((await json()).state.mode).toBe('no_copy')
    signedCopy()
    fx.latestFax = { id: 'l1', action_type: 'fax_sent', created_at: '2026-11-07T10:00:00Z', details: { job_id: '555', faxno: '8558877737' } }
    expect((await json()).state).toMatchObject({ mode: 'sent', faxJobId: '555', toIrsLine: true })
    fx.markers = [{ action_type: 'return_fax_confirmed', created_at: '2026-11-07T10:20:00Z', details: { job_id: '555' } }]
    expect((await json()).state.mode).toBe('delivered')
  })
  it('FAILS CLOSED: any lookup that fails is a 503 "nothing was sent", never "nothing was faxed"', async () => {
    signedCopy()
    for (const table of ['service_deliveries', 'accounts', 'esign_envelopes', 'documents', 'action_log']) {
      fx.fail = { [table]: true }
      const res = await call()
      expect(res.status, table).toBe(503)
      expect((await res.json()).success).toBe(false)
    }
  })
})
