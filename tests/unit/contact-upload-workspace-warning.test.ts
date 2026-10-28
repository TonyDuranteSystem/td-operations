/**
 * Dev job e3215801, "Door A" — the CONTACT page's "Upload Document". Staff pick "ITIN Letter" there while the person's ITIN case waits for
 * that letter: the page asks first (Open the workspace / Save in Storage only), and the route repeats the check before it downloads or saves
 * anything. Same incident as the Storage page (Adam Mihaly's letter filed hidden, the case left open).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'

const fx = vi.hoisted(() => ({
  staff: true,
  hits: [] as Array<Record<string, unknown>>,
  finderThrows: false,
  finderCalls: [] as Array<Record<string, unknown>>,
  removed: [] as string[],
  downloads: [] as string[],
}))

vi.mock('@/lib/auth/require-staff-route', () => ({
  requireStaffRoute: async () => (fx.staff ? null : NextResponse.json({ error: 'Staff only' }, { status: 403 })),
}))
vi.mock('@/lib/flows/storage-step-hints', () => ({
  findWaitingWorkspaceStepsForContact: async (input: Record<string, unknown>) => {
    fx.finderCalls.push(input)
    if (fx.finderThrows) throw new Error('boom')
    return fx.hits
  },
}))
vi.mock('@/lib/supabase-admin', () => ({
  supabaseAdmin: {
    storage: {
      from: () => ({
        remove: async (paths: string[]) => { fx.removed.push(...paths); return { data: null, error: null } },
        // the route got past the workspace gate when it reaches the download: answer "no data" so the test stops right there
        download: async (path: string) => { fx.downloads.push(path); return { data: null, error: { message: 'stop here' } } },
      }),
    },
  },
}))

import { POST as check } from '@/app/api/crm/admin-actions/workspace-check/route'
import { POST as upload } from '@/app/api/crm/admin-actions/upload-document/route'
import { contactUploadRouting } from '@/lib/crm-store/contact-upload-routing'

const HIT = {
  sdId: 'sd-1', serviceType: 'ITIN', stage: 'IRS Processing', who: 'Maria Rossi', asks: 'the IRS approval letter (CP565)', matchedBy: 'type',
  how: 'Press "ITIN Received" first, then upload the letter in the "Upload CP565 ITIN Letter" box.', storageDoes: [], workspaceDoes: ['close the case'],
  workspacePath: '/flows/sd-1', contactId: 'c-1', accountId: null,
}
const req = (path: string, body: Record<string, unknown>) => new NextRequest(`http://localhost${path}`, { method: 'POST', body: JSON.stringify(body) })
const UP = { contact_id: 'c-1', storage_path: 'crm-uploads/c-1/123_letter.pdf', file_name: 'letter.pdf', mime_type: 'application/pdf', document_type: 'ITIN Letter', category: 'Contacts' }

beforeEach(() => {
  fx.staff = true
  fx.hits = []
  fx.finderThrows = false
  fx.finderCalls = []
  fx.removed = []
  fx.downloads = []
})

describe('contactUploadRouting — what the contact page\'s dropdowns mean (one place for the save and the check)', () => {
  it('ITIN Letter -> itin_letter in the person\'s ITIN folder; Passport -> passport, never the ITIN folder; EIN Letter; everything else is "Other document"', () => {
    expect(contactUploadRouting('ITIN Letter', 'Contacts')).toEqual({ storeType: 'itin_letter', itinFolder: 'itin', checkFolderKind: 'itin' })
    expect(contactUploadRouting('Passport', 'Contacts')).toEqual({ storeType: 'passport', itinFolder: undefined, checkFolderKind: null })
    expect(contactUploadRouting('EIN Letter', 'Contacts').storeType).toBe('ein_letter_irs')
    for (const t of ['ID Document', 'Articles of Organization', 'Operating Agreement', 'Bank Statement', 'Tax Return', 'Other']) {
      expect(contactUploadRouting(t, 'Contacts').storeType, t).toBe('other_document')
    }
  })
  it('a category other than the person\'s own documents files into a company folder: no ITIN folder kind for the check (the type still counts)', () => {
    const r = contactUploadRouting('ITIN Letter', 'Company')
    expect(r.storeType).toBe('itin_letter')
    expect(r.checkFolderKind).toBeNull()
    expect(contactUploadRouting('ITIN Letter', undefined).checkFolderKind).toBe('itin')   // no category sent = Contacts, like the route
    expect(contactUploadRouting('ITIN Letter', null).checkFolderKind).toBeNull()          // null is NOT the default (the route maps it to Correspondence)
  })
})

describe('POST /api/crm/admin-actions/workspace-check', () => {
  it('staff only', async () => {
    fx.staff = false
    expect((await check(req('/x', { contact_id: 'c-1' }))).status).toBe(403)
  })
  it('needs a contact', async () => {
    expect((await check(req('/x', {}))).status).toBe(400)
  })
  it('reads the dropdown label the same way the save does and asks about the PERSON', async () => {
    fx.hits = [HIT]
    const res = await check(req('/x', { contact_id: 'c-1', document_type: 'ITIN Letter', category: 'Contacts' }))
    expect(res.status).toBe(200)
    expect((await res.json()).hits).toEqual([HIT])
    expect(fx.finderCalls[0]).toEqual({ contactId: 'c-1', documentType: 'itin_letter', folderKind: 'itin' })
  })
  it('a check that cannot be completed is a 503 "nothing was uploaded" — never an empty pass', async () => {
    fx.finderThrows = true
    const res = await check(req('/x', { contact_id: 'c-1', document_type: 'ITIN Letter' }))
    expect(res.status).toBe(503)
    expect((await res.json()).error).toContain('nothing was uploaded')
  })
})

describe('POST /api/crm/admin-actions/upload-document — the backstop', () => {
  it('A STEP IS WAITING and the page did not answer -> 409, NOTHING is downloaded or saved, the staged file is removed, the reason is plain', async () => {
    fx.hits = [HIT]
    const res = await upload(req('/x', UP))
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.success).toBe(false)
    expect(body.code).toBe('workspace_step_waiting')
    expect(body.detail).toContain('Maria Rossi\'s ITIN case is at "IRS Processing"')
    expect(body.detail).toContain('In the workspace: Press "ITIN Received" first')
    expect(body.detail).toContain('nothing was uploaded')
    expect(body.hits).toHaveLength(1)
    expect(fx.downloads).toEqual([])
    expect(fx.removed).toEqual([UP.storage_path])
  })

  it('"Save in Storage only" (the case is acknowledged) gets PAST the gate (it reaches the download)', async () => {
    fx.hits = [HIT]
    const res = await upload(req('/x', { ...UP, workspaceAck: ['sd-1'] }))
    expect(fx.downloads).toEqual([UP.storage_path])
    expect(res.status).toBe(500)                                   // our mock download fails on purpose — the point is the gate let it through
    expect((await res.json()).detail).toContain('stop here')
  })

  it('an answer for ANOTHER case does not cover this one; a malformed answer is not a pass', async () => {
    fx.hits = [HIT]
    expect((await upload(req('/x', { ...UP, workspaceAck: ['some-other-case'] }))).status).toBe(409)
    expect((await upload(req('/x', { ...UP, workspaceAck: 'sd-1' }))).status).toBe(409)
    expect((await upload(req('/x', { ...UP, workspaceAck: [1, null, {}] }))).status).toBe(409)
    expect(fx.downloads).toEqual([])
  })

  it('FAILS CLOSED: a check that cannot be completed uploads nothing (503) and the staged file is removed', async () => {
    fx.finderThrows = true
    const res = await upload(req('/x', UP))
    expect(res.status).toBe(503)
    expect((await res.json()).detail).toContain('nothing was uploaded')
    expect(fx.downloads).toEqual([])
    expect(fx.removed).toEqual([UP.storage_path])
  })

  it('nothing waiting -> the upload goes on as before (it reaches the download)', async () => {
    await upload(req('/x', { ...UP, document_type: 'Passport' }))
    expect(fx.downloads).toEqual([UP.storage_path])
    expect(fx.finderCalls[0]).toEqual({ contactId: 'c-1', documentType: 'passport', folderKind: null })
  })

  it('a staged file outside the CRM staging area is never removed by a refusal', async () => {
    fx.hits = [HIT]
    await upload(req('/x', { ...UP, storage_path: 'somewhere-else/../secret.pdf' }))
    expect(fx.removed).toEqual([])
  })
})
