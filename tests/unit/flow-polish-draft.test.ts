import { describe, it, expect, vi } from 'vitest'
import { requestPolish } from '@/lib/flows/polish-draft'

function fakeFetch(status: number, body: unknown) {
  return vi.fn(async () => ({ ok: status >= 200 && status < 300, json: async () => body })) as unknown as typeof fetch
}

const base = { message: 'hi', accountId: 'a1', contactId: 'c1', preserveLanguage: false }

describe('requestPolish', () => {
  it('returns the polished text and language', async () => {
    const f = fakeFetch(200, { polished: 'Hello', applied_language: 'English' })
    expect(await requestPolish(base, f)).toEqual({ kind: 'polished', text: 'Hello', appliedLanguage: 'English' })
  })

  it('sends both client ids, the language switch and an explicit language', async () => {
    const f = fakeFetch(200, { polished: 'x' })
    await requestPolish({ ...base, preserveLanguage: true, targetLanguage: 'Italian' }, f)
    const body = JSON.parse((f as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1].body)
    expect(body).toEqual({ message: 'hi', preserve_language: true, target_language: 'Italian', account_id: 'a1', contact_id: 'c1' })
  })

  it('leaves out ids that are missing', async () => {
    const f = fakeFetch(200, { polished: 'x' })
    await requestPolish({ ...base, accountId: null }, f)
    const body = JSON.parse((f as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1].body)
    expect(body.account_id).toBeUndefined()
    expect(body.contact_id).toBe('c1')
  })

  it('asks for a language when the route cannot tell', async () => {
    expect(await requestPolish(base, fakeFetch(200, { needs_language_choice: true }))).toEqual({ kind: 'ask' })
  })

  it("surfaces the server's own error", async () => {
    await expect(requestPolish(base, fakeFetch(429, { error: 'Too many requests. Please wait.' }))).rejects.toThrow('Too many requests. Please wait.')
  })

  it('falls back to a plain message when the error has no body', async () => {
    await expect(requestPolish(base, fakeFetch(500, {}))).rejects.toThrow('Failed to polish message')
  })

  it('rejects an empty answer', async () => {
    await expect(requestPolish(base, fakeFetch(200, {}))).rejects.toThrow()
  })
})
