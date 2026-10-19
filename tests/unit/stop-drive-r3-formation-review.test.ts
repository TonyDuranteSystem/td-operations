/**
 * Stop Drive S1d, form lanes round 3 — item 4: formation_form_review files an MMLLC exactly like the completion route.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

describe('4. formation_form_review — MMLLC with two members', () => {
  const st = vi.hoisted(() => ({ rows: {} as Record<string, unknown>, recorded: [] as Array<{ table: string; op: string; payload: unknown }>, saves: [] as Array<{ folder: string; paths: string[]; names: string[]; meta: Record<string, string> }>, alarms: [] as string[], study: false }))
  vi.mock('@/lib/supabase-admin', async () => ({ supabaseAdmin: (await import('./_legacy-drive-mocks')).makeSupabase(st.rows, st.recorded as never) }))
  vi.mock('@/lib/crm-store/switched-drive-guard', () => ({ liveOwnerOfAccount: async () => null, liveOwnerOfContact: async () => (st.study ? null : 'person-owner'), companyDocState: async () => 'drive' }))
  vi.mock('@/lib/crm-store/formation-pilot', () => ({ raisePilotAlarm: async (k: string) => { st.alarms.push(k) }, ensurePersonOwner: async () => 'person-owner' }))
  vi.mock('@/lib/form-to-drive', () => ({
    saveFormToDrive: async (_t: string, _d: unknown, paths: string[], folder: string, meta: Record<string, string>, opts?: { fileNameOf?: (p: string) => string }) => {
      st.saves.push({ folder, paths, names: paths.map((p) => opts?.fileNameOf?.(p) ?? p), meta })
      return { summaryFileId: 'store:s', copied: paths, failed: [], skipped: [], errors: [] }
    },
  }))
  vi.mock('@/lib/forms/archive-enqueue', () => ({ enqueueFormArchiveJob: async () => ({ status: 'enqueued' }) }))
  vi.mock('@/lib/jobs/queue', () => ({ enqueueJob: async () => ({ id: 'j1' }) }))
  vi.mock('@/lib/system-errors', () => ({ reportSystemError: async () => null }))

  const OWNER = 'formation/l1/passport_owner_ab_p.jpg', M0 = 'formation/l1/member_0_member_passport_ab_m0.jpg', M1 = 'formation/l1/member_1_member_passport_ab_m1.jpg', ART = 'formation/l1/other_ab_x.pdf'
  const SUBMITTED = {
    owner_first_name: 'Ada', owner_last_name: 'Owner', llc_name_1: 'Acme LLC',
    additional_members: [{ member_first_name: 'Bob', member_last_name: 'One', member_email: 'b@x.co' }, { member_first_name: 'Cy', member_last_name: 'Two', member_email: 'c@x.co' }],
  }
  beforeEach(() => {
    st.saves.length = 0; st.alarms.length = 0; st.study = false
    for (const k of Object.keys(st.rows)) delete st.rows[k]
    st.rows.formation_submissions = { id: 'f1', token: 'tok', status: 'completed', contact_id: 'owner-c', lead_id: 'l1', changed_fields: null, entity_type: 'MMLLC', state: 'WY', language: 'en', submitted_data: SUBMITTED, upload_paths: [OWNER, M0, M1, ART], completed_at: '2026-10-17T09:00:00Z' }
    st.rows.leads = { full_name: 'Ada Owner' }
    st.rows.contacts = { full_name: 'Ada Owner' }
    st.rows.store_owners = []
  })
  async function review() {
    const handlers: Record<string, (a: unknown) => Promise<{ content: Array<{ text: string }> }>> = {}
    const { registerFormationTools } = await import('@/lib/mcp/tools/formation')
    registerFormationTools({ tool: (n: string, _d: string, _s: unknown, h: never) => { handlers[n] = h } } as never)
    return (await handlers['formation_form_review']({ token: 'tok', apply_changes: true })).content[0].text
  }
  it('files under the PRIMARY contact the owner passport + other files, with member-aware names; the two members passports are NOT filed there', async () => {
    const text = await review()
    expect(st.saves).toHaveLength(1)
    expect(st.saves[0].folder).toBe('person-storage:owner-c')
    expect(st.saves[0].paths).toEqual([OWNER, ART])
    expect(st.saves[0].paths).not.toContain(M0); expect(st.saves[0].paths).not.toContain(M1)
    expect(st.saves[0].names[0]).toBe('passport_owner_Ada_Owner.jpg')
    expect(st.saves[0].meta).toMatchObject({ token: 'tok', submittedAt: '2026-10-17T09:00:00Z', companyName: 'Ada Owner' })
    expect(text).toMatch(/Package filed/)
  })
  it('a person with only a hidden study copy: nothing is filed, ONE alarm, the reply says so', async () => {
    st.study = true; st.rows.store_owners = [{ id: 'study' }]
    const text = await review()
    expect(st.saves).toEqual([])
    expect(st.alarms).toEqual(['lead_form_person_on_drive'])
    expect(text).toMatch(/Nothing/)
  })
})

