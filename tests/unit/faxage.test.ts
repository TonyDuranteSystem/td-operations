import { describe, it, expect, vi } from 'vitest'
import {
  normalizeFaxNo,
  isValidFaxNo,
  stripBase64Prefix,
  buildFaxageParams,
  parseFaxageResponse,
  sendFax,
  normalizeStatus,
  buildStatusParams,
  parseStatusResponse,
  getFaxStatus,
  buildDltransParams,
  interpretTransmittalBytes,
  getFaxTransmittal,
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

describe('normalizeStatus', () => {
  it('maps Faxage shortstatus to display status', () => {
    expect(normalizeStatus('success')).toBe('delivered')
    expect(normalizeStatus('pending')).toBe('pending')
    expect(normalizeStatus('failure')).toBe('failed')
    expect(normalizeStatus('SUCCESS')).toBe('delivered')
  })
  it('returns unknown for unexpected values', () => {
    expect(normalizeStatus('')).toBe('unknown')
    expect(normalizeStatus('weird')).toBe('unknown')
  })
})

describe('buildStatusParams', () => {
  it('builds a status request with the fixed optional flags', () => {
    const p = buildStatusParams(creds, { jobId: '42' })
    expect(p.get('operation')).toBe('status')
    expect(p.get('username')).toBe('u@example.com')
    expect(p.get('company')).toBe('u@example.com')
    expect(p.get('password')).toBe('secret')
    expect(p.get('jobid')).toBe('42')
    // Fixed flags make the appended columns deterministic.
    expect(p.get('pagecount')).toBe('1')
    expect(p.get('csid')).toBe('1')
    expect(p.get('showlogin')).toBe('1')
    expect(p.get('xmitpages')).toBe('1')
    expect(p.get('showtries')).toBe('1')
  })
  it('omits jobid when not provided (status of all jobs)', () => {
    const p = buildStatusParams(creds)
    expect(p.has('jobid')).toBe(false)
  })
})

describe('parseStatusResponse', () => {
  // 14 fields: jobid, commid, destname, destnum, shortstatus, longstatus,
  // sendtime, completetime, xmittime, pagecount, csid, login, xmitpages, tries.
  const line = [
    '12345', '67890', 'IRS', '8552151627', 'success', 'Sent OK',
    '2026-06-15 10:00:00', '2026-06-15 10:01:30', '00:01:12',
    '3', 'IRSFAX01', 'Tonyfax', '3', '1',
  ].join('\t')

  it('parses a single success record into structured fields', () => {
    const r = parseStatusResponse(line, true)
    expect(r.ok).toBe(true)
    expect(r.records).toHaveLength(1)
    const rec = r.records[0]
    expect(rec.jobId).toBe('12345')
    expect(rec.destNum).toBe('8552151627')
    expect(rec.shortStatus).toBe('success')
    expect(rec.status).toBe('delivered')
    expect(rec.sendTime).toBe('2026-06-15 10:00:00')
    expect(rec.completeTime).toBe('2026-06-15 10:01:30')
    expect(rec.xmitTime).toBe('00:01:12')
    expect(rec.pageCount).toBe('3')
    expect(rec.csid).toBe('IRSFAX01')
    expect(rec.xmitPages).toBe('3')
    expect(rec.tries).toBe('1')
  })

  it('parses multiple newline-separated records', () => {
    const r = parseStatusResponse(`${line}\n${line}`, true)
    expect(r.records).toHaveLength(2)
  })

  it('treats ERR06 (no jobs) as an empty, non-error result', () => {
    const r = parseStatusResponse('ERR06: No jobs to display or job id specified not found', true)
    expect(r.ok).toBe(true)
    expect(r.error).toBeNull()
    expect(r.records).toHaveLength(0)
  })

  it('treats other ERRxx tokens as failures', () => {
    const r = parseStatusResponse('ERR02: Login incorrect', true)
    expect(r.ok).toBe(false)
    expect(r.error).toContain('ERR02')
    expect(r.records).toHaveLength(0)
  })

  it('treats a non-2xx HTTP status as failure', () => {
    expect(parseStatusResponse('anything', false).ok).toBe(false)
  })

  it('is defensive about short/partial records', () => {
    const r = parseStatusResponse('12345\t\t\t8552151627\tpending', true)
    expect(r.ok).toBe(true)
    expect(r.records[0].jobId).toBe('12345')
    expect(r.records[0].status).toBe('pending')
    expect(r.records[0].xmitTime).toBe('')
  })
})

describe('getFaxStatus', () => {
  it('posts a status request and returns parsed records', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response('99\t1\tIRS\t8552151627\tpending\tIn queue\t2026-06-15 10:00:00\t0000-00-00 00:00:00\t00:00:00\t0\t\tTonyfax\t0\t0', { status: 200 }),
    ) as unknown as typeof fetch
    const r = await getFaxStatus(creds, { jobId: '99' }, fetchImpl)
    expect(r.ok).toBe(true)
    expect(r.records[0].status).toBe('pending')
    const [, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]
    expect((init as RequestInit).body).toContain('operation=status')
  })
})

describe('buildDltransParams', () => {
  it('builds a dltrans request defaulting to Eastern timezone', () => {
    const p = buildDltransParams(creds, '12345')
    expect(p.get('operation')).toBe('dltrans')
    expect(p.get('jobid')).toBe('12345')
    expect(p.get('jobtz')).toBe('4')
  })
  it('honors an explicit timezone', () => {
    const p = buildDltransParams(creds, '12345', { tz: '8' })
    expect(p.get('jobtz')).toBe('8')
  })
})

describe('interpretTransmittalBytes', () => {
  it('recognizes a PDF body as success', () => {
    const bytes = new TextEncoder().encode('%PDF-1.4\n…binary…')
    const r = interpretTransmittalBytes(bytes)
    expect(r.ok).toBe(true)
    expect(r.pdf).not.toBeNull()
  })
  it('treats a non-PDF body as an error message', () => {
    const bytes = new TextEncoder().encode('ERR28: JOB ID: 12345 does not exist')
    const r = interpretTransmittalBytes(bytes)
    expect(r.ok).toBe(false)
    expect(r.error).toContain('ERR28')
  })
})

describe('getFaxTransmittal', () => {
  it('returns the PDF bytes on success', async () => {
    const pdf = new TextEncoder().encode('%PDF-1.7 fake')
    const fetchImpl = vi.fn(async () =>
      new Response(pdf, { status: 200 }),
    ) as unknown as typeof fetch
    const r = await getFaxTransmittal(creds, '12345', {}, fetchImpl)
    expect(r.ok).toBe(true)
    expect(r.pdf?.toString('latin1')).toContain('%PDF')
  })
  it('returns an error when Faxage rejects the job', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response('ERR28: JOB ID: 12345 does not exist', { status: 200 }),
    ) as unknown as typeof fetch
    const r = await getFaxTransmittal(creds, '12345', {}, fetchImpl)
    expect(r.ok).toBe(false)
    expect(r.error).toContain('ERR28')
  })
})
