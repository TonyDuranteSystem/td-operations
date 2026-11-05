/**
 * Company Closure workspace, part A (dev job a6bbea09, Antonio 2026-11-05): the six step screens, the lock on the tracking number, the quiet
 * "tell the client nothing" delivery message, and the closure wizard answers on the screen.
 *
 * The screens are READ FROM THE MIGRATION ITSELF (scripts/migrations/20261106-0100-closure-workspace-part-a.sql), so what is tested is exactly
 * what will be written to the database — no second copy to drift.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { NextRequest } from 'next/server'
import { parseStageLayout } from '@/lib/flows/stage-layout'
import { buildStepHints, stepHintProblems } from '@/lib/flows/storage-step-rules'
import { trackingRequiredToAdvance, trackingMissingMessage } from '@/lib/flows/tracking-gate'
import { actionConfirmText } from '@/lib/flows/action-confirm'

const fx = vi.hoisted(() => ({
  // applyDeliveryConfirmation
  stageCfg: { tracking_delivered_message: null, client_chat_topic: null } as { tracking_delivered_message: string | null; client_chat_topic: string | null },
  inserted: [] as Array<{ table: string; row: Record<string, unknown> }>,
  // submission route
  sd: { id: 'sd-1', service_type: 'Company Closure', account_id: null, contact_id: null } as Record<string, unknown> | null,
  sub: null as Record<string, unknown> | null,
  subError: null as { message: string } | null,
  filters: [] as string[],
}))

vi.mock('@/lib/auth/require-staff-route', () => ({ requireStaffRoute: async () => null }))
vi.mock('@/lib/supabase-admin', () => ({
  supabaseAdmin: {
    from: (table: string) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const b: any = {}
      b.update = () => b
      b.eq = (c: string, v: unknown) => { fx.filters.push(`${table}.eq.${c}=${v}`); return b }
      b.in = (c: string, v: unknown) => { fx.filters.push(`${table}.in.${c}=${JSON.stringify(v)}`); return b }
      b.is = (c: string, v: unknown) => { fx.filters.push(`${table}.is.${c}=${v}`); return b }
      b.order = () => b
      b.limit = () => b
      b.select = () => (table === 'irs_shipment_tracking' ? Promise.resolve({ data: [{ id: 't1' }], error: null }) : b)
      b.single = () => Promise.resolve({ data: fx.sd, error: fx.sd ? null : { message: 'nope' } })
      b.maybeSingle = () =>
        Promise.resolve(table === 'pipeline_stages' ? { data: fx.stageCfg, error: null } : { data: fx.sub, error: fx.subError })
      b.insert = (row: Record<string, unknown>) => { fx.inserted.push({ table, row }); return Promise.resolve({ error: null }) }
      return b
    },
  },
}))

import { applyDeliveryConfirmation } from '@/lib/operations/irs-tracking-confirm'
import { GET as getSubmission } from '@/app/api/flows/[id]/submission/route'

const MIGRATION = readFileSync(path.join(process.cwd(), 'scripts/migrations/20261106-0100-closure-workspace-part-a.sql'), 'utf8')
const UNDO = readFileSync(path.join(process.cwd(), 'scripts/migrations/20261106-0100-closure-workspace-part-a.UNDO.sql'), 'utf8')

const STEP_ORDER = ['Data Collection', 'State Compliance Check', 'State Dissolution Filing', 'IRS Closure', 'Waiting for the IRS', 'Closing']

/** The six stage_layout blocks the migration writes, by step name. */
function layoutsInMigration(): Map<string, { raw: string; json: unknown }> {
  const out = new Map<string, { raw: string; json: unknown }>()
  const re = /stage_layout = \$j\$(.*?)\$j\$::jsonb[\s\S]*?stage_name = '([^']+)'/g
  let m: RegExpExecArray | null
  while ((m = re.exec(MIGRATION))) out.set(m[2], { raw: m[1], json: JSON.parse(m[1]) })
  return out
}
const layouts = layoutsInMigration()
const rows = STEP_ORDER.map((name, i) => ({ service_type: 'Company Closure', stage_name: name, stage_order: i + 1, stage_layout: layouts.get(name)?.json ?? null }))

beforeEach(() => {
  fx.stageCfg = { tracking_delivered_message: null, client_chat_topic: null }
  fx.inserted = []
  fx.sd = { id: 'sd-1', service_type: 'Company Closure', account_id: null, contact_id: null }
  fx.sub = null
  fx.subError = null
  fx.filters = []
})

describe('the six closure screens (as written by the migration)', () => {
  it('writes a screen for every step, and nothing else', () => {
    expect([...layouts.keys()].sort()).toEqual([...STEP_ORDER].sort())
  })

  it('every screen is readable by the renderer and carries the chat box — "write to the client in the portal chat" on every step', () => {
    for (const name of STEP_ORDER) {
      const parsed = parseStageLayout(layouts.get(name)?.json)
      expect(parsed, name).not.toBeNull()
      expect(parsed!.components.length, name).toBeGreaterThan(0)
      expect(parsed!.components.some((c) => c.type === 'chat'), `${name} has the chat box`).toBe(true)
      expect(parsed!.description, name).toBeTruthy()
    }
  })

  it('every component survives parsing (an unknown type would be silently dropped from the screen)', () => {
    for (const name of STEP_ORDER) {
      const raw = (layouts.get(name)!.json as { components: unknown[] }).components
      expect(parseStageLayout(layouts.get(name)!.json)!.components.length, name).toBe(raw.length)
    }
  })

  it('the "forward" buttons walk the steps in order and every target is a real step', () => {
    const next = new Map<string, string>()
    for (const name of STEP_ORDER) {
      for (const c of parseStageLayout(layouts.get(name)!.json)!.components) {
        for (const a of c.actions ?? []) {
          if (typeof a === 'object' && a.key === 'advance_next' && a.target) next.set(name, a.target)
        }
      }
    }
    expect(Object.fromEntries(next)).toEqual({
      'Data Collection': 'State Compliance Check',
      'State Compliance Check': 'State Dissolution Filing',
      'State Dissolution Filing': 'IRS Closure',
      'IRS Closure': 'Waiting for the IRS',
      'Waiting for the IRS': 'Closing',
    })
    for (const target of next.values()) expect(STEP_ORDER).toContain(target)
  })

  it('no upload moves a job on by itself; finishing the job is a button that ASKS first, and for a company of ours it says the company will be closed', () => {
    for (const name of ['State Dissolution Filing', 'IRS Closure', 'Waiting for the IRS']) {
      expect(parseStageLayout(layouts.get(name)!.json)!.components.find((c) => c.type === 'document_upload')?.autoAdvance, name).toBe(false)
    }
    const finish = parseStageLayout(layouts.get('Waiting for the IRS')!.json)!.components.find((c) => c.type === 'action_buttons')!.actions![0]
    expect(typeof finish === 'object' && finish.target).toBe('Closing')
    expect(actionConfirmText(finish, false)).toMatch(/Finish the closure job/)
    expect(actionConfirmText(finish, true)).toMatch(/CLOSES THE COMPANY/)
    expect(actionConfirmText(finish, true)).toMatch(/portal is turned off/)
  })

  it('the storage rules built from the screens are clean and name the three documents', () => {
    expect(stepHintProblems(rows)).toEqual([])
    const hints = buildStepHints(rows)
    expect(hints.map((h) => [h.boxStage, h.documentTypes[0]])).toEqual([
      ['State Dissolution Filing', 'certificate_of_dissolution'],
      ['IRS Closure', 'ein_cancellation_request'],
      ['Waiting for the IRS', 'ein_cancellation_receipt_from_irs'],
    ])
  })

  it('only the "IRS Closure" screen locks the next step on a saved tracking number', () => {
    for (const name of STEP_ORDER) {
      expect(trackingRequiredToAdvance(layouts.get(name)!.json), name).toBe(name === 'IRS Closure')
    }
  })

  it('the migration adds "Waiting for the IRS" just before "Closing": waiting on the IRS, daily tracking check on, delivery message EMPTY, needs the letter to leave', () => {
    expect(MIGRATION).toMatch(/'Company Closure', v_closing_order, 'Waiting for the IRS'/)
    expect(MIGRATION).toMatch(/42, false, false, 'the_irs', false, true,\s+false, false, true, true, true,\s+'', v_entry\)/)
    expect(MIGRATION).toMatch(/stage_name = 'State Dissolution Filing'/)
    expect(MIGRATION).toMatch(/requires_document_to_advance = true/)
    expect(MIGRATION).toMatch(/notify_client_email = false/)
  })

  it('the UNDO carries every screen verbatim (so it only removes what the migration wrote) and refuses while a job is on the new step', () => {
    // the new step's own screen goes with the step (the step row is deleted); the other five are removed only while they are still the migration's
    for (const [name, { raw }] of layouts) if (name !== 'Waiting for the IRS') expect(UNDO, name).toContain(raw)
    expect(UNDO).toMatch(/closure jobs still sit on Waiting for the IRS/)
  })
})

describe('trackingRequiredToAdvance / trackingMissingMessage', () => {
  it('is true only for an irs_tracking_entry box marked requiredToAdvance', () => {
    expect(trackingRequiredToAdvance({ components: [{ type: 'irs_tracking_entry', requiredToAdvance: true }] })).toBe(true)
    expect(trackingRequiredToAdvance({ components: [{ type: 'irs_tracking_entry' }] })).toBe(false)
    expect(trackingRequiredToAdvance({ components: [{ type: 'irs_tracking_entry', requiredToAdvance: false }] })).toBe(false)
    expect(trackingRequiredToAdvance({ components: [{ type: 'chat', requiredToAdvance: true }] })).toBe(false)
  })
  it('never throws on a missing or broken layout — no layout means no lock', () => {
    for (const v of [null, undefined, 'x', 42, {}, { components: 'no' }, { components: [null, 3] }]) expect(trackingRequiredToAdvance(v)).toBe(false)
  })
  it('keeps the older ITIN sentence word for word', () => {
    expect(trackingMissingMessage('Waiting for the IRS')).toBe('Enter the IRS mailing tracking number before moving this case to "Waiting for the IRS".')
  })
  it('parseStageLayout keeps requiredToAdvance and helpText, and drops a non-boolean / blank value', () => {
    const c = parseStageLayout({ components: [{ type: 'irs_tracking_entry', requiredToAdvance: true, helpText: ' Save it. ' }, { type: 'irs_tracking_entry', requiredToAdvance: 'yes', helpText: '  ' }] })!.components
    expect(c[0].requiredToAdvance).toBe(true)
    expect(c[0].helpText).toBe(' Save it. ')
    expect(c[1].requiredToAdvance).toBeUndefined()
    expect(c[1].helpText).toBeUndefined()
  })
})

describe('applyDeliveryConfirmation — what the client hears when the letter is delivered', () => {
  const sd = { id: 'sd-1', service_type: 'Company Closure', stage: 'Waiting for the IRS', account_id: null, contact_id: 'c-1' }
  const row = { service_delivery_id: 'sd-1', tracking_number: '9400' }

  it('an EMPTY delivery message means the client is told nothing (the delivery is still recorded)', async () => {
    fx.stageCfg = { tracking_delivered_message: '', client_chat_topic: null }
    const r = await applyDeliveryConfirmation(sd, row, '2026-11-05T12:00:00Z')
    expect(r).toEqual({ justConfirmed: true })
    expect(fx.inserted).toEqual([])
  })
  it('no message set (null) keeps the old behaviour: the standard good-news line goes to the client chat', async () => {
    fx.stageCfg = { tracking_delivered_message: null, client_chat_topic: null }
    const r = await applyDeliveryConfirmation(sd, row, '2026-11-05T12:00:00Z')
    expect(r.justConfirmed).toBe(true)
    expect(fx.inserted).toHaveLength(1)
    expect(fx.inserted[0].table).toBe('portal_messages')
    expect(fx.inserted[0].row.message).toBe('Good news — the IRS has received your application.')
    expect(fx.inserted[0].row.topic).toBe('Company Closure')
  })
  it('a configured message is sent as written, on the configured topic', async () => {
    fx.stageCfg = { tracking_delivered_message: 'Good news — the IRS has received your ITIN application.', client_chat_topic: 'ITIN' }
    await applyDeliveryConfirmation(sd, row, '2026-11-05T12:00:00Z')
    expect(fx.inserted[0].row.message).toBe('Good news — the IRS has received your ITIN application.')
    expect(fx.inserted[0].row.topic).toBe('ITIN')
  })
})

describe('closure wizard answers on the workspace (GET /api/flows/[id]/submission)', () => {
  const get = async () => {
    const res = await getSubmission(new NextRequest('http://localhost/api/flows/sd-1/submission'), { params: { id: 'sd-1' } })
    return { status: res.status, body: await res.json() }
  }

  it('a job with a company is matched by the company', async () => {
    fx.sd = { id: 'sd-1', service_type: 'Company Closure', account_id: 'acc-1', contact_id: 'c-1' }
    fx.sub = { submitted_data: { llc_name: 'Acme LLC' }, status: 'completed', completed_at: '2026-11-05T10:00:00Z', created_at: '2026-11-05T09:00:00Z' }
    const { body } = await get()
    expect(body.source).toBe('closure')
    expect(body.submission.submitted_data).toEqual({ llc_name: 'Acme LLC' })
    expect(body.submission.created_at).toBe('2026-11-05T10:00:00Z')
    expect(fx.filters).toContain('closure_submissions.eq.account_id=acc-1')
    expect(fx.filters.some((f) => f.includes('contact_id'))).toBe(false)
  })

  it('a job for a company that is NOT ours (no company) is matched by the person, and only wizards with no company', async () => {
    fx.sd = { id: 'sd-1', service_type: 'Company Closure', account_id: null, contact_id: 'c-1' }
    fx.sub = { submitted_data: { llc_name: 'Italyflow LLC' }, status: 'completed', completed_at: null, created_at: '2026-11-04T09:00:00Z' }
    const { body } = await get()
    expect(fx.filters).toContain('closure_submissions.eq.contact_id=c-1')
    expect(fx.filters).toContain('closure_submissions.is.account_id=null')
    expect(body.submission.created_at).toBe('2026-11-04T09:00:00Z')
  })

  it('only finished wizards count (completed or reviewed), never a half-filled one', async () => {
    fx.sd = { id: 'sd-1', service_type: 'Company Closure', account_id: 'acc-1', contact_id: null }
    await get()
    expect(fx.filters).toContain('closure_submissions.in.status=["completed","reviewed"]')
  })

  it('no wizard yet is an empty answer, not an error', async () => {
    fx.sd = { id: 'sd-1', service_type: 'Company Closure', account_id: 'acc-1', contact_id: null }
    fx.sub = null
    const { status, body } = await get()
    expect(status).toBe(200)
    expect(body).toEqual({ success: true, source: 'closure', submission: null })
  })

  it('a job with neither a company nor a person has nothing to show', async () => {
    fx.sd = { id: 'sd-1', service_type: 'Company Closure', account_id: null, contact_id: null }
    const { body } = await get()
    expect(body).toEqual({ success: true, source: 'closure', submission: null })
  })

  it('a database error is reported with its real message (R099), not swallowed', async () => {
    fx.sd = { id: 'sd-1', service_type: 'Company Closure', account_id: 'acc-1', contact_id: null }
    fx.subError = { message: 'boom' }
    const { status, body } = await get()
    expect(status).toBe(500)
    expect(body.error).toContain('boom')
  })
})

describe('actionConfirmText — "ask before you act" on a workspace button', () => {
  it('a bare key or a button with no sentence acts at once', () => {
    expect(actionConfirmText('approve', true)).toBeNull()
    expect(actionConfirmText({ key: 'advance_next', target: 'X' }, true)).toBeNull()
    expect(actionConfirmText({ key: 'advance_next', target: 'X', confirm: '   ' }, false)).toBeNull()
  })
  it('the company sentence is used only for a job with a company, otherwise the plain one', () => {
    const a = { key: 'advance_next', target: 'X', confirm: 'Plain?', confirmCompany: 'Company!' }
    expect(actionConfirmText(a, true)).toBe('Company!')
    expect(actionConfirmText(a, false)).toBe('Plain?')
  })
  it('a company-only sentence means a job with no company acts at once; a plain-only sentence is asked for both', () => {
    expect(actionConfirmText({ key: 'advance_next', target: 'X', confirmCompany: 'Company!' }, false)).toBeNull()
    expect(actionConfirmText({ key: 'advance_next', target: 'X', confirm: 'Plain?' }, true)).toBe('Plain?')
  })
  it('parseStageLayout keeps the sentences and drops blank or non-text ones', () => {
    const [c] = parseStageLayout({ components: [{ type: 'action_buttons', actions: [{ key: 'advance_next', target: 'X', confirm: ' Sure? ', confirmCompany: '', label: 'Go' }, { key: 'advance_next', target: 'Y', confirm: 7 }] }] })!.components
    expect(c.actions).toEqual([{ key: 'advance_next', label: 'Go', target: 'X', confirm: ' Sure? ' }, { key: 'advance_next', target: 'Y' }])
  })
})
