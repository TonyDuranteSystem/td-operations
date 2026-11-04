/**
 * GET /api/onboarding-review/[id]/articles-check — the State Filing ID check's data (job 64d2be64): the client's Articles of Organization,
 * links to open them, and the number the reader finds on them. Only files that belong to THIS submission are ever signed or read; the
 * reading has a time budget and a size limit, and a failed reading never costs staff the documents.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/auth/require-staff-route', () => ({ requireStaffRoute: vi.fn(async () => null) }))

let submission: Record<string, unknown> | null = null
const downloaded: string[] = []
let downloadFails = new Set<string>()
let blobTypeByPath: Record<string, string> = {}
let sizeByPath: Record<string, number> = {}
vi.mock('@/lib/supabase-admin', () => ({
  supabaseAdmin: {
    from: () => {
      const chain: Record<string, unknown> = {}
      chain.select = () => chain
      chain.eq = () => chain
      chain.single = async () => (submission ? { data: submission, error: null } : { data: null, error: { message: 'not found' } })
      return chain
    },
    storage: {
      from: () => ({
        download: async (path: string) => {
          downloaded.push(path)
          if (downloadFails.has(path)) return { data: null, error: { message: 'gone' } }
          return { data: { type: blobTypeByPath[path] ?? 'application/pdf', size: sizeByPath[path] ?? 8, arrayBuffer: async () => new ArrayBuffer(8) }, error: null }
        },
      }),
    },
  },
}))

const signedFor: string[][] = []
let signingFails = false
vi.mock('@/lib/storage/signed-urls', () => ({
  createSignedUrlMap: async (_bucket: string, paths: string[]) => {
    signedFor.push(paths)
    if (signingFails) throw new Error('storage down')
    return new Map(paths.map((p) => [p, `https://signed.example/${encodeURIComponent(p)}`]))
  },
}))

// the OCR text of each file, keyed by the file name the route passes in; files in `ocrHangs` never answer, files in `ocrThrows` fail
let textByFile: Record<string, string> = {}
let ocrHangs = new Set<string>()
let ocrThrows = new Set<string>()
const ocrMimes: string[] = []
vi.mock('@/lib/docai', () => ({
  DOCAI_INLINE_MAX_BYTES: 15 * 1024 * 1024,
  ocrRawContent: async (_buf: ArrayBuffer, mime: string, fileName: string) => {
    ocrMimes.push(mime)
    if (ocrHangs.has(fileName)) return new Promise(() => {})
    if (ocrThrows.has(fileName)) throw new Error('docai failed')
    return { fullText: textByFile[fileName] ?? '' }
  },
}))

import { GET } from '@/app/api/onboarding-review/[id]/articles-check/route'

const call = () => GET(new Request('http://localhost/x') as unknown as import('next/server').NextRequest, { params: { id: 'sub-1' } })

const ARTICLES_A = 'onboarding/lead-1/articles_of_organization_aaa_First Articles.pdf'
const ARTICLES_B = 'onboarding/lead-1/articles_of_organization_bbb_Second Articles.pdf'
const NAME_A = 'articles_of_organization_aaa_First Articles.pdf'
const NAME_B = 'articles_of_organization_bbb_Second Articles.pdf'

beforeEach(() => {
  submission = { token: 'tok-1', contact_id: null, account_id: null, offer_id: null, lead_id: 'lead-1', upload_paths: [] }
  downloaded.length = 0
  signedFor.length = 0
  ocrMimes.length = 0
  downloadFails = new Set()
  blobTypeByPath = {}
  sizeByPath = {}
  signingFails = false
  textByFile = {}
  ocrHangs = new Set()
  ocrThrows = new Set()
})

afterEach(() => { vi.useRealTimers() })

describe('onboarding review — Articles check', () => {
  it('404s an unknown submission', async () => {
    submission = null
    expect((await call()).status).toBe(404)
  })

  it('says so, and reads nothing, when the client uploaded no Articles', async () => {
    submission = { ...submission!, upload_paths: ['onboarding/lead-1/passport_owner_1_Passport.pdf'] }
    const data = await (await call()).json()
    expect(data).toMatchObject({ success: true, has_articles: false, documents: [], read_number: null, read_from: null, read_note: null })
    expect(downloaded).toHaveLength(0)
  })

  it('returns the Articles with signed links and the number the reader found', async () => {
    submission = { ...submission!, upload_paths: ['onboarding/lead-1/passport_owner_1_Passport.pdf', ARTICLES_A] }
    textByFile = { [NAME_A]: 'Wyoming\nOriginal ID: 2026-002103965\nSecretary of State' }
    const data = await (await call()).json()
    expect(data.has_articles).toBe(true)
    expect(data.read_number).toBe('2026-002103965')
    expect(data.read_from).toBe(ARTICLES_A)
    expect(data.read_note).toBeNull()
    expect(data.documents).toHaveLength(1)
    expect(data.documents[0]).toMatchObject({ path: ARTICLES_A, file_name: NAME_A, mime_type: 'application/pdf' })
    expect(data.documents[0].url).toContain('https://signed.example/')
    // the passport was never signed or read
    expect(signedFor).toEqual([[ARTICLES_A]])
    expect(downloaded).toEqual([ARTICLES_A])
  })

  it('a document the reader finds nothing on still comes back, with read_number null and no scary note', async () => {
    submission = { ...submission!, upload_paths: [ARTICLES_A] }
    textByFile = { [NAME_A]: 'a contract with no Filing ID in it' }
    const data = await (await call()).json()
    expect(data).toMatchObject({ success: true, has_articles: true, read_number: null, read_from: null, read_note: null })
    expect(data.documents).toHaveLength(1)
  })

  it('looks at the next file when the first gives no number, and says which one it read', async () => {
    submission = { ...submission!, upload_paths: [ARTICLES_A, ARTICLES_B] }
    textByFile = { [NAME_A]: 'nothing here', [NAME_B]: 'Florida\nDocument Number L26000009149\n' }
    const data = await (await call()).json()
    expect(data.read_number).toBe('L26000009149')
    expect(data.read_from).toBe(ARTICLES_B)
    expect(downloaded).toEqual([ARTICLES_A, ARTICLES_B])
  })

  it('an unreadable file does not hide the document or stop the next one', async () => {
    submission = { ...submission!, upload_paths: [ARTICLES_A, ARTICLES_B] }
    downloadFails = new Set([ARTICLES_A])
    textByFile = { [NAME_B]: 'File #: 3190157' }
    const data = await (await call()).json()
    expect(data.documents).toHaveLength(2)
    expect(data.read_number).toBe('3190157')
    expect(data.read_note).toBeNull()
  })

  it('never signs or reads a path that is not this submission\'s own', async () => {
    submission = { ...submission!, upload_paths: ['onboarding/someone-else/articles_of_organization_x_Other Client.pdf'] }
    const res = await call()
    // uploaded Articles that this submission does not own are NOT "no Articles": that would unlock Confirm with nothing to look at
    expect(res.status).toBe(422)
    expect((await res.json()).error).toMatch(/1 uploaded Articles file could not be matched to this submission/)
    expect(signedFor).toHaveLength(0)
    expect(downloaded).toHaveLength(0)
  })

  it('a submission with no Articles uploaded at all is still plainly "no Articles"', async () => {
    submission = { ...submission!, upload_paths: ['onboarding/lead-1/passport_owner_1_Passport.pdf'] }
    const res = await call()
    expect(res.status).toBe(200)
    expect((await res.json()).has_articles).toBe(false)
  })

  it('crafted paths that walk out of the folder are never signed or read, and count as unmatched', async () => {
    submission = { ...submission!, upload_paths: [
      'onboarding/lead-1/../../../rest/v1/x?q=/articles_of_organization.pdf',
      'onboarding/lead-1/../someone-else/articles_of_organization_z.pdf',
      'onboarding/lead-1\\..\\articles_of_organization_y.pdf',
    ] }
    const res = await call()
    expect(res.status).toBe(422)
    // the backslash path has no Articles-looking last segment, so it is not counted — but it is still never signed or read
    expect((await res.json()).error).toMatch(/2 uploaded Articles files could not be matched/)
    expect(signedFor).toHaveLength(0)
    expect(downloaded).toHaveLength(0)
  })

  it('a good file next to unmatched ones is shown, and the unmatched ones are counted', async () => {
    submission = { ...submission!, upload_paths: [ARTICLES_A, 'onboarding/someone-else/articles_of_organization_x_Other.pdf'] }
    textByFile = { [NAME_A]: 'Original ID: 2026-002103965' }
    const data = await (await call()).json()
    expect(data.has_articles).toBe(true)
    expect(data.documents).toHaveLength(1)
    expect(data.unmatched_articles).toBe(1)
    expect(data.read_number).toBe('2026-002103965')
  })

  it('a file whose name has ? # or % is still shown to staff but is not fetched by path', async () => {
    const odd = 'onboarding/lead-1/articles_of_organization_ab12_Articles #2.pdf'
    submission = { ...submission!, upload_paths: [odd] }
    const data = await (await call()).json()
    expect(data.has_articles).toBe(true)
    expect(data.documents).toHaveLength(1)
    expect(downloaded).toHaveLength(0)
    expect(data.read_number).toBeNull()
    expect(data.read_note).toMatch(/could not read this file/)
  })

  it('reads at most three files', async () => {
    const paths = [1, 2, 3, 4, 5].map((n) => `onboarding/lead-1/articles_of_organization_${n}_File ${n}.pdf`)
    submission = { ...submission!, upload_paths: paths }
    const data = await (await call()).json()
    expect(data.documents).toHaveLength(5)
    expect(downloaded).toHaveLength(3)
  })
})

describe('onboarding review — Articles check keeps working when things go wrong', () => {
  it('a failure to make the links still returns the documents (url null) and still reads the number', async () => {
    submission = { ...submission!, upload_paths: [ARTICLES_A] }
    signingFails = true
    textByFile = { [NAME_A]: 'Original ID: 2026-002103965' }
    const res = await call()
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.has_articles).toBe(true)
    expect(data.documents[0].url).toBeNull()
    expect(data.read_number).toBe('2026-002103965')
  })

  it('a reader that fails is a plain note, and the documents still come back', async () => {
    submission = { ...submission!, upload_paths: [ARTICLES_A] }
    ocrThrows = new Set([NAME_A])
    const data = await (await call()).json()
    expect(data.read_number).toBeNull()
    expect(data.read_note).toMatch(/could not read this file/i)
    expect(data.documents).toHaveLength(1)
  })

  it('a file over the reader\'s size limit is skipped without reading it, with the reason', async () => {
    submission = { ...submission!, upload_paths: [ARTICLES_A] }
    sizeByPath = { [ARTICLES_A]: 40 * 1024 * 1024 }
    textByFile = { [NAME_A]: 'Original ID: 2026-002103965' }
    const data = await (await call()).json()
    expect(data.read_number).toBeNull()
    expect(data.read_note).toMatch(/too large/i)
    expect(ocrMimes).toHaveLength(0)
    expect(data.documents).toHaveLength(1)
  })

  it('a reader that never answers is cut off, the note says it ran out of time, and the documents come back', async () => {
    vi.useFakeTimers()
    submission = { ...submission!, upload_paths: [ARTICLES_A] }
    ocrHangs = new Set([NAME_A])
    const pending = call()
    await vi.advanceTimersByTimeAsync(30_000)
    const data = await (await pending).json()
    expect(data.read_number).toBeNull()
    expect(data.read_note).toMatch(/ran out of time/i)
    expect(data.documents).toHaveLength(1)
    expect(data.documents[0].url).toContain('https://signed.example/')
  })

  it('the whole reading stops at its budget — later files are not started once the time is used up', async () => {
    vi.useFakeTimers()
    submission = { ...submission!, upload_paths: [ARTICLES_A, ARTICLES_B] }
    ocrHangs = new Set([NAME_A, NAME_B])
    const pending = call()
    await vi.advanceTimersByTimeAsync(60_000)
    const data = await (await pending).json()
    expect(data.read_note).toMatch(/ran out of time/i)
    expect(data.documents).toHaveLength(2)
  })

  it('a generic stored type falls back to the file name\'s type for the reader (the wizard stores octet-stream when the browser gave none)', async () => {
    const photo = 'onboarding/lead-1/articles_of_organization_ccc_Scan.png'
    submission = { ...submission!, upload_paths: [photo] }
    blobTypeByPath = { [photo]: 'application/octet-stream' }
    await call()
    expect(ocrMimes).toEqual(['image/png'])
  })

  it('a real stored type is used as it is', async () => {
    submission = { ...submission!, upload_paths: [ARTICLES_A] }
    blobTypeByPath = { [ARTICLES_A]: 'application/pdf' }
    await call()
    expect(ocrMimes).toEqual(['application/pdf'])
  })
})
