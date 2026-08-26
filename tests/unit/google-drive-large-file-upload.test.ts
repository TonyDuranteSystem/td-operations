/**
 * uploadBinaryToDrive's large-file branching: Google's "multipart" upload
 * type is only reliable under ~5MB (Google's own docs) — a real 18MB
 * passport photo hit that ceiling with no retry and no visible error,
 * leaving the file stuck in raw storage forever (dev_task: Turcanu/Tacoli
 * passport investigation). Anything over the safe multipart threshold must
 * go through Google's resumable protocol instead (init POST → PUT to the
 * returned session URL).
 *
 * Mocks jose (JWT signing is real crypto, irrelevant to this logic) and
 * fetch (three legs: OAuth token exchange, resumable init, resumable PUT).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('jose', () => ({
  importPKCS8: vi.fn().mockResolvedValue('fake-key'),
  SignJWT: vi.fn().mockImplementation(function (this: Record<string, unknown>) {
    this.setProtectedHeader = vi.fn().mockReturnThis()
    this.setIssuer = vi.fn().mockReturnThis()
    this.setAudience = vi.fn().mockReturnThis()
    this.setIssuedAt = vi.fn().mockReturnThis()
    this.setExpirationTime = vi.fn().mockReturnThis()
    this.sign = vi.fn().mockResolvedValue('fake-jwt')
  }),
}))

const ORIGINAL_SANDBOX = process.env.SANDBOX_MODE
const ORIGINAL_SA_KEY = process.env.GOOGLE_SA_KEY

beforeEach(() => {
  // driveMocked() must be false so the real upload path runs.
  delete process.env.SANDBOX_MODE
  process.env.GOOGLE_SA_KEY = Buffer.from(
    JSON.stringify({ client_email: 'test@test.iam.gserviceaccount.com', private_key: 'fake', token_uri: 'https://oauth2.googleapis.com/token' }),
  ).toString('base64')
})

afterEach(() => {
  if (ORIGINAL_SANDBOX === undefined) delete process.env.SANDBOX_MODE
  else process.env.SANDBOX_MODE = ORIGINAL_SANDBOX
  if (ORIGINAL_SA_KEY === undefined) delete process.env.GOOGLE_SA_KEY
  else process.env.GOOGLE_SA_KEY = ORIGINAL_SA_KEY
  vi.unstubAllGlobals()
  vi.resetModules()
})

describe('uploadBinaryToDrive — small file (unchanged multipart path)', () => {
  it('uses a single multipart POST for a file under the safe threshold', async () => {
    const fetchMock = vi.fn()
    fetchMock.mockImplementationOnce(() =>
      Promise.resolve(new Response(JSON.stringify({ access_token: 'fake-token', expires_in: 3600 }), { status: 200 })),
    )
    fetchMock.mockImplementationOnce((url: string) => {
      expect(String(url)).toContain('uploadType=multipart')
      return Promise.resolve(new Response(JSON.stringify({ id: 'small-file-id', name: 'small.pdf' }), { status: 200 }))
    })
    vi.stubGlobal('fetch', fetchMock)

    const { uploadBinaryToDrive } = await import('@/lib/google-drive')
    const result = await uploadBinaryToDrive('small.pdf', Buffer.from('x'.repeat(1000)), 'application/pdf', 'folder-1')

    expect(result).toEqual({ id: 'small-file-id', name: 'small.pdf' })
    // Exactly 2 calls: token exchange + one multipart POST. No resumable init/PUT.
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})

describe('uploadBinaryToDrive — large file (resumable path)', () => {
  it('initiates a resumable session and PUTs the file when over the safe multipart threshold', async () => {
    const bigData = Buffer.alloc(5 * 1024 * 1024 + 1, 'a') // just over the 4MB threshold
    const fetchMock = vi.fn()
    fetchMock.mockImplementationOnce(() =>
      Promise.resolve(new Response(JSON.stringify({ access_token: 'fake-token', expires_in: 3600 }), { status: 200 })),
    )
    fetchMock.mockImplementationOnce((url: string, init: RequestInit) => {
      expect(String(url)).toContain('uploadType=resumable')
      expect((init.headers as Record<string, string>)['X-Upload-Content-Length']).toBe(String(bigData.length))
      return Promise.resolve(
        new Response(null, { status: 200, headers: { Location: 'https://upload.example/session/abc123' } }),
      )
    })
    fetchMock.mockImplementationOnce((url: string, init: RequestInit) => {
      expect(url).toBe('https://upload.example/session/abc123')
      expect(init.method).toBe('PUT')
      return Promise.resolve(new Response(JSON.stringify({ id: 'large-file-id', name: 'passport.png' }), { status: 200 }))
    })
    vi.stubGlobal('fetch', fetchMock)

    const { uploadBinaryToDrive } = await import('@/lib/google-drive')
    const result = await uploadBinaryToDrive('passport.png', bigData, 'image/png', 'folder-1')

    expect(result).toEqual({ id: 'large-file-id', name: 'passport.png' })
    expect(fetchMock).toHaveBeenCalledTimes(3) // token + resumable init + PUT
  })

  it('throws a clear error when the resumable init does not return a session URL', async () => {
    const bigData = Buffer.alloc(5 * 1024 * 1024 + 1)
    const fetchMock = vi.fn()
    fetchMock.mockImplementationOnce(() =>
      Promise.resolve(new Response(JSON.stringify({ access_token: 'fake-token', expires_in: 3600 }), { status: 200 })),
    )
    fetchMock.mockImplementationOnce(() => Promise.resolve(new Response(null, { status: 200 }))) // no Location header
    vi.stubGlobal('fetch', fetchMock)

    const { uploadBinaryToDrive } = await import('@/lib/google-drive')
    await expect(uploadBinaryToDrive('passport.png', bigData, 'image/png', 'folder-1')).rejects.toThrow(
      /did not return a session URL/,
    )
  })

  it('throws a clear error when the resumable PUT fails', async () => {
    const bigData = Buffer.alloc(5 * 1024 * 1024 + 1)
    const fetchMock = vi.fn()
    fetchMock.mockImplementationOnce(() =>
      Promise.resolve(new Response(JSON.stringify({ access_token: 'fake-token', expires_in: 3600 }), { status: 200 })),
    )
    fetchMock.mockImplementationOnce(() =>
      Promise.resolve(new Response(null, { status: 200, headers: { Location: 'https://upload.example/session/abc123' } })),
    )
    fetchMock.mockImplementationOnce(() =>
      Promise.resolve(new Response(JSON.stringify({ error: { message: 'quota exceeded' } }), { status: 403 })),
    )
    vi.stubGlobal('fetch', fetchMock)

    const { uploadBinaryToDrive } = await import('@/lib/google-drive')
    await expect(uploadBinaryToDrive('passport.png', bigData, 'image/png', 'folder-1')).rejects.toThrow(
      /quota exceeded/,
    )
  })
})
