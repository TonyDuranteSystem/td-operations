import { describe, it, expect } from 'vitest'
import { isValidCapturePath } from '@/lib/captures/storage'

describe('isValidCapturePath', () => {
  it('accepts a well-formed server-generated path', () => {
    expect(isValidCapturePath('captures/3fa85f64-5717-4562-b3fc-2c963f66afa6.png')).toBe(true)
  })

  it('accepts different lowercase extensions', () => {
    expect(isValidCapturePath('captures/3fa85f64-5717-4562-b3fc-2c963f66afa6.jpg')).toBe(true)
    expect(isValidCapturePath('captures/3fa85f64-5717-4562-b3fc-2c963f66afa6.pdf')).toBe(true)
  })

  it('accepts an uppercase UUID (case-insensitive)', () => {
    expect(isValidCapturePath('captures/3FA85F64-5717-4562-B3FC-2C963F66AFA6.png')).toBe(true)
  })

  it('rejects a path outside the captures/ prefix (e.g. another feature\'s file)', () => {
    expect(isValidCapturePath('worker-chat/3fa85f64-5717-4562-b3fc-2c963f66afa6.png')).toBe(false)
  })

  it('rejects a path traversal attempt', () => {
    expect(isValidCapturePath('captures/../worker-chat/secret.pdf')).toBe(false)
  })

  it('rejects a client-chosen (non-UUID) filename', () => {
    expect(isValidCapturePath('captures/my-file.png')).toBe(false)
  })

  it('rejects a UUID with no extension', () => {
    expect(isValidCapturePath('captures/3fa85f64-5717-4562-b3fc-2c963f66afa6')).toBe(false)
  })

  it('rejects an empty string', () => {
    expect(isValidCapturePath('')).toBe(false)
  })
})
