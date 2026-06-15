import { describe, it, expect, vi } from 'vitest'
import {
  normalizeFaxNo,
  isValidFaxNo,
  stripBase64Prefix,
  buildFaxageParams,
  parseFaxageResponse,
  sendFax,
  type SendFaxInput,
} from '@/lib/fax/faxage'

const creds = { username: 'u@example.com', company: 'u@example.com', password: 'secret' }

describe('normalizeFaxNo', () => {
  it('strips formatting to digits', () => {
    expect(normalizeFaxNo('(855) 215-1627')).toBe('8552151627')
    expect(normalizeFaxNo('+1 800 555 1234')).toBe('18005551234')
  })
  it('handles empty/undefined safely', () => {
    expect(normalizeFaxNo('')).toBe('')
    expect(normalizeFaxNo(undefined as unknown as string)).toBe('')
  })
})

describe('isValidFaxNo', () => {
  it('accepts 10–15 digit numbers', () => {
    expect(isValidFaxNo('8552151627')).toBe(true)
    expect(isValidFaxNo('+1 (800) 555-1234')).toBe(true)
  })
  it('rejects too-short or empty numbers', () => {
    expect(isValidFaxNo('12345')).toBe(false)
    expect(isValidFaxNo('')).toBe(false)
  })
  it('rejects absurdly long numbers', () => {
    expect(isValidFaxNo('1234567890123456')).toBe(false)
  })
})

describe('stripBase64Prefix', () => {
  it('removes a data: URI prefix', () => {
    expect(stripBase64Prefix('data:application/pdf;base64,AAAA')).toBe('AAAA')
  })
  it('passes through raw base64 unchanged', () => {
    expect(stripBase64Prefix('AAAA')).toBe('AAAA')
  })
  it('handles empty input', () => {
    expect(stripBase64Prefix('')).toBe('')
  })
})

describe('buildFaxageParams', () => {
  const base: SendFaxInput = {
    credentials: creds,
    faxno: '(855) 215-1627',
    fileName: 'return.pdf',
    fileBase64: 'data:application/pdf;base64,JVBERi0=',
    recipName: 'IRS',
  }

  it('builds the documented sendfax fields with indexed file arrays', () => {
    const p = buildFaxageParams(base)
    expect(p.get('operation')).toBe('sendfax')
    expect(p.get('username')).toBe('u@example.com')
    expect(p.get('company')).toBe('u@example.com')
    expect(p.get('password')).toBe('secret')
    expect(p.get('faxno')).toBe('8552151627')
    expect(p.get('recipname')).toBe('IRS')
    expect(p.get('faxfilenames[0]')).toBe('return.pdf')
    expect(p.get('faxfiledata[0]')).toBe('JVBERi0=')
  })

  it('defaults company to username when company is blank', () => {
    const p = buildFaxageParams({ ...base, credentials: { ...creds, company: '' } })
    expect(p.get('company')).toBe('u@example.com')
  })

  it('omits recipname when not provided', () => {
    const p = buildFaxageParams({ ...base, recipName: undefined })
    expect(p.has('recipname')).toBe(false)
  })

  it('falls back to a default filename', () => {
    const p = buildFaxageParams({ ...base, fileName: '' })
    expect(p.get('faxfilenames[0]')).toBe('document.pdf')
  })
})

describe('parseFaxageResponse', () => {
  it('parses a labelled job id on success', () => {
    const r = parseFaxageResponse('Success JobNum: 998877', true)
    expect(r.ok).toBe(true)
    expect(r.jobId).toBe('998877')
  })
  it('parses a bare numeric id on a non-error response', () => {
    const r = parseFaxageResponse('123456', true)
    expect(r.ok).toBe(true)
    expect(r.jobId).toBe('123456')
  })
  it('flags error tokens as failures', () => {
    expect(parseFaxageResponse('ERR: invalid login', true).ok).toBe(false)
    expect(parseFaxageResponse('Authentication failed', true).ok).toBe(false)
    expect(parseFaxageResponse('Access denied', true).ok).toBe(false)
  })
  it('treats a non-2xx HTTP status as failure even with friendly text', () => {
    const r = parseFaxageResponse('ok', false)
    expect(r.ok).toBe(false)
  })
  it('does not pull a job id out of an error response', () => {
    const r = parseFaxageResponse('Error code 500', true)
    expect(r.ok).toBe(false)
    expect(r.jobId).toBeNull()
  })
})

describe('sendFax', () => {
  it('posts urlencoded params and returns the parsed result', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response('JobNum: 42', { status: 200 }),
    ) as unknown as typeof fetch

    const result = await sendFax(
      {
        credentials: creds,
        faxno: '8552151627',
        fileName: 'return.pdf',
        fileBase64: 'JVBERi0=',
        recipName: 'IRS',
      },
      fetchImpl,
    )

    expect(result.ok).toBe(true)
    expect(result.jobId).toBe('42')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(url).toContain('faxage.com')
    expect((init as RequestInit).method).toBe('POST')
    expect((init as RequestInit).body).toContain('operation=sendfax')
  })

  it('surfaces a Faxage error as ok=false', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response('ERR: bad number', { status: 200 }),
    ) as unknown as typeof fetch
    const result = await sendFax(
      { credentials: creds, faxno: '8552151627', fileName: 'x.pdf', fileBase64: 'AA==' },
      fetchImpl,
    )
    expect(result.ok).toBe(false)
    expect(result.raw).toContain('bad number')
  })
})
