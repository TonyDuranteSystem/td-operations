/**
 * Tax Return plan item 7 (dev job 6f555c9f) — the delivery check of an EXTENSION fax (lib/fax/extension-fax-delivery.ts), tested with fakes for every
 * outside piece: when the fax is delivered the Form 7004 and the receipt are merged into ONE document and saved (shown to the client), the job moves
 * to "Extension Filed" and the client is told — each once; a failed or never-confirmed fax moves nothing; a problem with the document never stops the
 * filing (the fax was delivered) but is reported once.
 */
import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import { processExtensionFaxDelivery, type ExtensionFaxDeps, type ExtensionJob, type ExtensionFaxRow } from '@/lib/fax/extension-fax-delivery'
import { EXTENSION_FAX_MARKERS } from '@/lib/fax/extension-fax'

const WORK = Buffer.from('%PDF-1.4 the form 7004 as faxed')
const RECEIPT = Buffer.from('%PDF-1.4 the faxage receipt')
const HASH = createHash('sha256').update(WORK).digest('hex')

const JOB: ExtensionJob = {
  id: 'sd-1', service_type: 'Tax Return', stage: '1st Installment Paid', status: 'active', account_id: 'acc-1', contact_id: 'con-1',
  service_name: 'Tax Return 2025 - Acme LLC', due_date: null, created_at: '2026-01-10T00:00:00Z', stage_entered_at: '2026-02-01T00:00:00Z',
}
const FAX_AT = '2026-11-09T10:00:00Z'
const FAX: ExtensionFaxRow = { created_at: FAX_AT, record_id: 'doc-1', details: { job_id: 'F1', faxno: '8558877737', document_id: 'doc-1', content_hash: HASH } }
const NOW = Date.parse(FAX_AT) + 30 * 60_000 // 30 minutes after the send

interface Calls {
  markers: Array<{ kind: string; details: Record<string, unknown> }>
  alerts: string[]
  saved: Array<{ name: string; key: string; visibleToClient: boolean; documentType: string; bytes: Buffer }>
  moves: string[]
  messages: string[]
  merges: Buffer[][]
}

function make(over: Partial<ExtensionFaxDeps> & { job?: ExtensionJob | null; fax?: ExtensionFaxRow | null; status?: 'delivered' | 'failed' | 'pending' | 'unknown'; markers?: string[] } = {}) {
  const calls: Calls = { markers: [], alerts: [], saved: [], moves: [], messages: [], merges: [] }
  const have = new Set<string>(over.markers ?? [])
  let job: ExtensionJob | null = over.job === undefined ? { ...JOB } : over.job
  const deps: ExtensionFaxDeps = {
    now: () => NOW,
    loadJob: async () => ({ job, error: null }),
    latestFax: async () => ({ row: over.fax === undefined ? FAX : over.fax, error: null }),
    markerExists: async (kind) => ({ exists: have.has(kind), error: null }),
    faxStatus: async () => ({ status: over.status ?? 'delivered', error: null }),
    transmittal: async () => ({ pdf: RECEIPT, error: null }),
    taxYear: () => 2025,
    companyName: async () => 'Acme LLC',
    readWorkingCopy: async () => ({ bytes: WORK, error: null }),
    merge: async (parts) => { calls.merges.push(parts); return Buffer.concat(parts) },
    saveDocument: async (p) => { calls.saved.push({ name: p.name, key: p.key, visibleToClient: p.visibleToClient, documentType: p.documentType, bytes: p.bytes }); return { route: 'store', fileId: `f-${calls.saved.length}` } },
    advanceToFiled: async (_id, notes) => { calls.moves.push(notes); if (job) job = { ...job, stage: 'Extension Filed' }; return { ok: true } },
    clientIsItalian: async () => false,
    extensionDeadline: async () => '2026-10-15',
    postClientMessage: async ({ message }) => { calls.messages.push(message); return { posted: true, alreadyThere: false, error: null } },
    writeMarker: async (kind, p) => { calls.markers.push({ kind, details: p.details }); have.add(kind); return { error: null } },
    alert: async (m) => { calls.alerts.push(m) },
    ...over,
  }
  return { deps, calls }
}

describe('which jobs are checked', () => {
  it('a job that is not found, not a Tax Return, or at another step is left alone', async () => {
    expect((await processExtensionFaxDelivery('x', make({ job: null }).deps)).outcome).toBe('not_applicable')
    expect((await processExtensionFaxDelivery('x', make({ job: { ...JOB, service_type: 'ITIN' } }).deps)).outcome).toBe('not_applicable')
    expect((await processExtensionFaxDelivery('x', make({ job: { ...JOB, stage: 'Data Received' } }).deps)).outcome).toBe('not_applicable')
    expect((await processExtensionFaxDelivery('x', make({ job: { ...JOB, status: 'cancelled' } }).deps)).outcome).toBe('not_applicable')
  })
  it('no extension fax on record → nothing to check and Faxage is not asked', async () => {
    const m = make({ fax: null, faxStatus: async () => { throw new Error('must not be called') } })
    expect(await processExtensionFaxDelivery('x', m.deps)).toEqual({ outcome: 'no_fax' })
  })
  it('a history row with no Faxage job id cannot be checked: an error (retried), nothing moves', async () => {
    const m = make({ fax: { ...FAX, details: { faxno: '8558877737' } } })
    expect((await processExtensionFaxDelivery('x', m.deps)).outcome).toBe('error')
    expect(m.calls.moves).toEqual([])
  })
  it('a fax already confirmed is done: a re-run or a clash with "Check now" does nothing twice', async () => {
    const m = make({ markers: [EXTENSION_FAX_MARKERS.confirmed] })
    expect(await processExtensionFaxDelivery('x', m.deps)).toEqual({ outcome: 'already_done' })
    expect(m.calls.moves).toEqual([])
    expect(m.calls.messages).toEqual([])
  })
})

describe('waiting, failed, waiting too long', () => {
  it('still waiting → nothing moves, nothing is said', async () => {
    const m = make({ status: 'pending' })
    expect((await processExtensionFaxDelivery('x', m.deps)).outcome).toBe('pending')
    expect(m.calls.moves).toEqual([])
    expect(m.calls.alerts).toEqual([])
  })
  it('failed → ONE marker and ONE alert per fax; the job stays; a second run adds nothing', async () => {
    const m = make({ status: 'failed' })
    expect((await processExtensionFaxDelivery('x', m.deps)).outcome).toBe('failed')
    expect((await processExtensionFaxDelivery('x', m.deps)).outcome).toBe('failed')
    expect(m.calls.markers.filter((x) => x.kind === EXTENSION_FAX_MARKERS.failed)).toHaveLength(1)
    expect(m.calls.alerts).toHaveLength(1)
    expect(m.calls.moves).toEqual([])
    expect(m.calls.saved).toEqual([])
  })
  it('waiting more than 2 hours → ONE alert, the job stays, and it is still checked', async () => {
    const m = make({ status: 'pending', now: () => Date.parse(FAX_AT) + 3 * 3600_000 })
    expect((await processExtensionFaxDelivery('x', m.deps)).outcome).toBe('waiting_too_long')
    expect((await processExtensionFaxDelivery('x', m.deps)).outcome).toBe('waiting_too_long')
    expect(m.calls.markers.filter((x) => x.kind === EXTENSION_FAX_MARKERS.stale)).toHaveLength(1)
    expect(m.calls.alerts).toHaveLength(1)
    expect(m.calls.moves).toEqual([])
  })
  it('a Faxage status that cannot be read is an error to retry, never a filing', async () => {
    const m = make({ faxStatus: async () => ({ status: 'unknown', error: 'Faxage said no' }) })
    expect(await processExtensionFaxDelivery('x', m.deps)).toEqual({ outcome: 'error', error: 'Faxage said no' })
    expect(m.calls.moves).toEqual([])
  })
})

describe('delivered', () => {
  it('merges the Form 7004 (first) with the receipt, saves ONE document shown to the client, moves the job, tells the client, writes the marker LAST', async () => {
    const m = make()
    const r = await processExtensionFaxDelivery('x', m.deps)
    expect(r).toEqual({ outcome: 'filed', documentSaved: true, messagePosted: true })
    expect(m.calls.merges).toEqual([[WORK, RECEIPT]]) // the 7004 first, the receipt after it
    expect(m.calls.saved).toHaveLength(1)
    expect(m.calls.saved[0]).toMatchObject({ name: 'Form 7004 + IRS fax receipt - Acme LLC - Tax Return 2025.pdf', key: 'extension-7004-merged:F1', visibleToClient: true, documentType: 'form_7004' })
    expect(m.calls.moves).toHaveLength(1)
    expect(m.calls.messages).toHaveLength(1)
    expect(m.calls.messages[0]).toContain('filed the extension')
    expect(m.calls.messages[0]).toContain('October 15, 2026')
    expect(m.calls.messages[0]).toContain('Documents')
    expect(m.calls.markers).toHaveLength(1)
    expect(m.calls.markers[0]).toMatchObject({ kind: EXTENSION_FAX_MARKERS.confirmed, details: { job_id: 'F1', faxno: '8558877737', document_saved: true, message_posted: true } })
    expect(m.calls.alerts).toEqual([])
  })
  it('the client\'s message is in Italian for an Italian client', async () => {
    const m = make({ clientIsItalian: async () => true })
    await processExtensionFaxDelivery('x', m.deps)
    expect(m.calls.messages[0]).toContain('proroga')
    expect(m.calls.messages[0]).toContain('15 ottobre 2026')
  })
  it('a fax to ANY number counts once Faxage says it was delivered (the number is the IRS\'s to change)', async () => {
    const m = make({ fax: { ...FAX, details: { ...FAX.details, faxno: '8001234567' } } })
    expect((await processExtensionFaxDelivery('x', m.deps)).outcome).toBe('filed')
  })
  it('the receipt page not ready yet → try again next run: nothing saved, nothing moved, nothing said', async () => {
    const m = make({ transmittal: async () => ({ pdf: null, error: 'ERR28' }) })
    expect(await processExtensionFaxDelivery('x', m.deps)).toEqual({ outcome: 'pending', note: 'ERR28' })
    expect(m.calls.saved).toEqual([])
    expect(m.calls.moves).toEqual([])
    expect(m.calls.messages).toEqual([])
  })
  it('a second run after a full success does nothing (the marker says it is done)', async () => {
    const m = make()
    await processExtensionFaxDelivery('x', m.deps)
    expect((await processExtensionFaxDelivery('x', m.deps)).outcome).toBe('already_done')
    expect(m.calls.moves).toHaveLength(1)
    expect(m.calls.messages).toHaveLength(1)
  })
  it('a crash after the move (the job is already at "Extension Filed", no marker) still saves what is missing, tells the client and writes the marker — and does not move again', async () => {
    const m = make({ job: { ...JOB, stage: 'Extension Filed' } })
    const r = await processExtensionFaxDelivery('x', m.deps)
    expect(r.outcome).toBe('filed')
    expect(m.calls.moves).toEqual([])
    expect(m.calls.messages).toHaveLength(1)
    expect(m.calls.markers).toHaveLength(1)
  })
  it('a client already told (a retry after a crash) is not told twice, and the marker still records it', async () => {
    const m = make({ postClientMessage: async () => ({ posted: false, alreadyThere: true, error: null }) })
    const r = await processExtensionFaxDelivery('x', m.deps)
    expect(r).toEqual({ outcome: 'filed', documentSaved: true, messagePosted: true })
  })
})

describe('a problem with the document never stops the filing, and is reported once', () => {
  const noDocBut = (over: Partial<ExtensionFaxDeps>) => make(over)
  it('the stored Form 7004 was changed after it was faxed → no merged document, the receipt is kept by itself (internal), the job is filed, the message does not point to a document, ONE alert', async () => {
    const m = noDocBut({ readWorkingCopy: async () => ({ bytes: Buffer.from('%PDF-1.4 something else'), error: null }) })
    const r = await processExtensionFaxDelivery('x', m.deps)
    expect(r).toEqual({ outcome: 'filed', documentSaved: false, messagePosted: true })
    expect(m.calls.merges).toEqual([])
    expect(m.calls.saved).toHaveLength(1)
    expect(m.calls.saved[0]).toMatchObject({ name: 'IRS fax receipt (Form 7004) - Acme LLC - Tax Return 2025.pdf', visibleToClient: false, documentType: 'fax_confirmation' })
    expect(m.calls.messages[0]).not.toContain('Documents')
    expect(m.calls.moves).toHaveLength(1)
    expect(m.calls.alerts).toHaveLength(1)
    expect(m.calls.alerts[0]).toContain('changed after it was faxed')
  })
  it('the Form 7004 cannot be read → same: filed, the receipt kept, one alert that names the way to save it by hand', async () => {
    const m = noDocBut({ readWorkingCopy: async () => ({ bytes: null, error: 'gone' }) })
    const r = await processExtensionFaxDelivery('x', m.deps)
    expect(r).toMatchObject({ outcome: 'filed', documentSaved: false })
    expect(m.calls.alerts).toHaveLength(1)
    expect(m.calls.alerts[0]).toContain('Merge into one')
  })
  it('the merge fails → same', async () => {
    const m = noDocBut({ merge: async () => { throw new Error('locked PDF') } })
    const r = await processExtensionFaxDelivery('x', m.deps)
    expect(r).toMatchObject({ outcome: 'filed', documentSaved: false })
    expect(m.calls.alerts[0]).toContain('locked PDF')
  })
  it('the company has no storage → filed, the message does not point to a document, one alert', async () => {
    const m = noDocBut({ saveDocument: async () => ({ route: 'drive' as const }) })
    const r = await processExtensionFaxDelivery('x', m.deps)
    expect(r).toMatchObject({ outcome: 'filed', documentSaved: false })
    expect(m.calls.alerts[0]).toContain('no storage')
  })
  it('a history row without a content hash (an older send) still merges: the hash is checked only when it is there', async () => {
    const m = make({ fax: { ...FAX, details: { job_id: 'F1', faxno: '8558877737', document_id: 'doc-1' } } })
    expect((await processExtensionFaxDelivery('x', m.deps)).outcome).toBe('filed')
    expect(m.calls.merges).toHaveLength(1)
  })
  it('the job has no company → filed without a document, one alert', async () => {
    const m = make({ job: { ...JOB, account_id: null } })
    const r = await processExtensionFaxDelivery('x', m.deps)
    expect(r).toMatchObject({ outcome: 'filed', documentSaved: false })
    expect(m.calls.alerts).toHaveLength(1)
  })
})

describe('the move and the message', () => {
  it('a move that is refused → an alert and an error to retry; the client is NOT told and no marker is written', async () => {
    const m = make({ advanceToFiled: async () => ({ ok: false, error: 'blocked' }) })
    const r = await processExtensionFaxDelivery('x', m.deps)
    expect(r).toEqual({ outcome: 'error', error: 'blocked' })
    expect(m.calls.messages).toEqual([])
    expect(m.calls.markers).toEqual([])
    expect(m.calls.alerts.some((a) => a.includes('did not move'))).toBe(true)
  })
  it('a move that lost a race with another check (the job is already at "Extension Filed") counts as done', async () => {
    let loads = 0
    const m = make({
      loadJob: async () => { loads++; return { job: loads === 1 ? { ...JOB } : { ...JOB, stage: 'Extension Filed' }, error: null } },
      advanceToFiled: async () => ({ ok: false, error: 'already moved' }),
    })
    expect((await processExtensionFaxDelivery('x', m.deps)).outcome).toBe('filed')
  })
  it('a chat message that could not be posted → the extension is still filed, ONE alert tells staff to tell the client by hand', async () => {
    const m = make({ postClientMessage: async () => ({ posted: false, alreadyThere: false, error: 'chat down' }) })
    const r = await processExtensionFaxDelivery('x', m.deps)
    expect(r).toEqual({ outcome: 'filed', documentSaved: true, messagePosted: false })
    expect(m.calls.alerts.some((a) => a.includes('Tell the client by hand'))).toBe(true)
  })
  it('a marker that cannot be written is reported, but the job stays filed', async () => {
    const m = make({ writeMarker: async () => ({ error: 'db down' }) })
    const r = await processExtensionFaxDelivery('x', m.deps)
    expect(r.outcome).toBe('filed')
    expect(m.calls.alerts.some((a) => a.includes('confirmation marker'))).toBe(true)
  })
  it('never throws: an exception anywhere is an error to retry', async () => {
    const m = make({ merge: undefined, readWorkingCopy: async () => { throw new Error('boom') } })
    expect(await processExtensionFaxDelivery('x', m.deps)).toEqual({ outcome: 'error', error: 'boom' })
  })
})
