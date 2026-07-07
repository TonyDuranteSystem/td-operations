/**
 * uploadBinaryToDriveUpsert decision logic (runs under SANDBOX_MODE=1 so the
 * underlying write primitives return mocks without network).
 *
 * Locks in:
 *   1. Name present in the provided map → overwrite in place (same file id).
 *   2. Name absent → create.
 *   3. Null map (listing failed upstream) → create, never omit.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'

const ORIGINAL_SANDBOX = process.env.SANDBOX_MODE

beforeEach(() => {
  process.env.SANDBOX_MODE = '1'
})

afterEach(() => {
  if (ORIGINAL_SANDBOX === undefined) delete process.env.SANDBOX_MODE
  else process.env.SANDBOX_MODE = ORIGINAL_SANDBOX
})

import { uploadBinaryToDriveUpsert } from '@/lib/google-drive'

const DATA = Buffer.from('test')

describe('uploadBinaryToDriveUpsert', () => {
  it('overwrites in place when the name already exists in the folder map', async () => {
    const existing = new Map([['PnL 2025.xlsx', 'file-123']])
    const res = await uploadBinaryToDriveUpsert('PnL 2025.xlsx', DATA, 'application/pdf', 'folder-1', existing)
    expect(res.action).toBe('overwritten')
    expect(res.id).toBe('file-123') // same file id — no new copy
  })

  it('creates when the name is not in the folder map', async () => {
    const res = await uploadBinaryToDriveUpsert('PnL 2025.xlsx', DATA, 'application/pdf', 'folder-1', new Map())
    expect(res.action).toBe('created')
  })

  it('creates when the folder listing failed (null map) — never omits', async () => {
    const res = await uploadBinaryToDriveUpsert('PnL 2025.xlsx', DATA, 'application/pdf', 'folder-1', null)
    expect(res.action).toBe('created')
  })
})
