import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * readPdfInput accepts BOTH request shapes for the staff create routes. The JSON
 * (direct-upload) shape must go through the claim, the multipart (original) shape must
 * keep working untouched, and `discard()` must clean up only what a claim created.
 */

const claim = vi.hoisted(() => vi.fn())
const discard = vi.hoisted(() => vi.fn(async () => {}))

vi.mock('@/lib/esign/staging', () => ({
  claimStagedPdf: claim,
  discardStaged: discard,
}))

import { readPdfInput } from '@/lib/esign/read-pdf-input'
import type { NextRequest } from 'next/server'

const USER = '11111111-2222-4333-8444-555555555555'

function jsonReq(body: unknown): NextRequest {
  return new Request('http://localhost/api/esign/envelopes', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }) as unknown as NextRequest
}

beforeEach(() => {
  claim.mockReset()
  discard.mockClear()
})

describe('readPdfInput — direct-upload (JSON) shape', () => {
  it('claims the staged file for the caller and returns its bytes + payload', async () => {
    claim.mockResolvedValue({ kind: 'claimed', ok: true, bytes: new Uint8Array([1, 2, 3]), claimedPath: 'esign-staging/u/claimed-x.pdf' })
    const r = await readPdfInput(jsonReq({ staging_path: 'esign-staging/u/o.pdf', file_name: 'UGC return.pdf', payload: { document_name: 'D' } }), USER)
    expect(claim).toHaveBeenCalledWith('esign-staging/u/o.pdf', USER)
    expect(r.ok).toBe(true)
    if (r.kind === 'ready') {
      expect(Array.from(r.bytes)).toEqual([1, 2, 3])
      expect(r.fileName).toBe('UGC return.pdf')
      expect(r.payload).toEqual({ document_name: 'D' })
      await r.discard()
      expect(discard).toHaveBeenCalledWith('esign-staging/u/claimed-x.pdf')
    }
  })

  it('passes the claim failure straight through (status + plain message)', async () => {
    claim.mockResolvedValue({ kind: 'refused', ok: false, status: 404, error: 'That upload is no longer available — please choose the file again.' })
    const r = await readPdfInput(jsonReq({ staging_path: 'esign-staging/u/o.pdf', payload: {} }), USER)
    expect(r).toEqual({ kind: 'refused', ok: false, status: 404, error: 'That upload is no longer available — please choose the file again.' })
  })

  it('a request with no staging path is refused by the claim, never read from anywhere else', async () => {
    claim.mockResolvedValue({ kind: 'refused', ok: false, status: 400, error: 'Invalid upload reference — please choose the file again.' })
    const r = await readPdfInput(jsonReq({ payload: {} }), USER)
    expect(claim).toHaveBeenCalledWith(undefined, USER)
    expect(r.ok).toBe(false)
  })

  it('malformed JSON is a 400, not a crash', async () => {
    const req = new Request('http://localhost/x', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{nope' }) as unknown as NextRequest
    const r = await readPdfInput(req, USER)
    expect(r).toEqual({ kind: 'refused', ok: false, status: 400, error: 'Invalid request.' })
    expect(claim).not.toHaveBeenCalled()
  })

  it('a missing payload becomes an empty object (the route then reports the missing field)', async () => {
    claim.mockResolvedValue({ kind: 'claimed', ok: true, bytes: new Uint8Array([1]), claimedPath: 'c' })
    const r = await readPdfInput(jsonReq({ staging_path: 'p' }), USER)
    expect(r.kind === 'ready' && r.payload).toEqual({})
  })
})

describe('readPdfInput — original multipart shape', () => {
  it('still reads the uploaded file and payload, with a no-op discard', async () => {
    const form = new FormData()
    form.append('pdf', new File([new Uint8Array([37, 80, 68, 70])], 'small.pdf', { type: 'application/pdf' }))
    form.append('payload', JSON.stringify({ document_name: 'Small' }))
    const req = new Request('http://localhost/x', { method: 'POST', body: form }) as unknown as NextRequest
    const r = await readPdfInput(req, USER)
    expect(r.ok).toBe(true)
    if (r.kind === 'ready') {
      expect(Array.from(r.bytes)).toEqual([37, 80, 68, 70])
      expect(r.fileName).toBe('small.pdf')
      expect(r.payload).toEqual({ document_name: 'Small' })
      await r.discard()
      expect(discard).not.toHaveBeenCalled()
    }
    expect(claim).not.toHaveBeenCalled()
  })

  it('keeps the original error sentences', async () => {
    const noFile = new FormData()
    noFile.append('payload', '{}')
    const r1 = await readPdfInput(new Request('http://localhost/x', { method: 'POST', body: noFile }) as unknown as NextRequest, USER)
    expect(r1).toEqual({ kind: 'refused', ok: false, status: 400, error: 'A PDF file is required.' })

    const badPayload = new FormData()
    badPayload.append('pdf', new File(['x'], 'a.pdf'))
    badPayload.append('payload', '{nope')
    const r2 = await readPdfInput(new Request('http://localhost/x', { method: 'POST', body: badPayload }) as unknown as NextRequest, USER)
    expect(r2).toEqual({ kind: 'refused', ok: false, status: 400, error: 'Invalid payload JSON.' })
  })

  it('a body that is neither JSON nor multipart is a 400', async () => {
    const req = new Request('http://localhost/x', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'hello' }) as unknown as NextRequest
    const r = await readPdfInput(req, USER)
    expect(r).toEqual({ kind: 'refused', ok: false, status: 400, error: 'Expected multipart form data.' })
  })
})
