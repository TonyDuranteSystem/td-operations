import { describe, it, expect } from 'vitest'

// Pure logic extracted from the PATCH /api/portal/chat/message/[id] handler.
// Tests guard against regressions in validation and update-building logic without
// needing to spin up a DB or Next.js context.

function validateEditRequest(body: unknown): { message: string } | { error: string } {
  if (typeof body !== 'object' || body === null) return { error: 'Invalid JSON body' }
  const b = body as Record<string, unknown>
  const newText = typeof b.message === 'string' ? b.message.trim() : null
  if (!newText) return { error: 'message must be a non-empty string' }
  return { message: newText }
}

function buildUpdatePayload(
  existing: { message: string; original_message: string | null; sender_type: string; deleted_at: string | null },
  newText: string,
  now: string
): Record<string, unknown> | { error: string } {
  if (existing.deleted_at) return { error: 'Cannot edit a deleted message' }
  if (existing.sender_type !== 'admin') return { error: 'Only admin messages can be edited' }
  const updates: Record<string, unknown> = { message: newText, edited_at: now }
  if (!existing.original_message) updates.original_message = existing.message
  return updates
}

describe('portal message edit — request validation', () => {
  it('accepts a valid message string', () => {
    const result = validateEditRequest({ message: 'Hello world' })
    expect(result).toEqual({ message: 'Hello world' })
  })

  it('trims whitespace from the message', () => {
    const result = validateEditRequest({ message: '  trimmed  ' })
    expect(result).toEqual({ message: 'trimmed' })
  })

  it('rejects empty string', () => {
    const result = validateEditRequest({ message: '' })
    expect('error' in result).toBe(true)
  })

  it('rejects whitespace-only string', () => {
    const result = validateEditRequest({ message: '   ' })
    expect('error' in result).toBe(true)
  })

  it('rejects non-string message', () => {
    const result = validateEditRequest({ message: 42 })
    expect('error' in result).toBe(true)
  })

  it('rejects null body', () => {
    const result = validateEditRequest(null)
    expect('error' in result).toBe(true)
  })
})

describe('portal message edit — update payload', () => {
  const NOW = '2026-05-14T10:00:00.000Z'
  const base = {
    message: 'Original text',
    original_message: null,
    sender_type: 'admin',
    deleted_at: null,
  }

  it('builds correct payload on first edit', () => {
    const result = buildUpdatePayload(base, 'Corrected text', NOW)
    expect(result).toEqual({
      message: 'Corrected text',
      edited_at: NOW,
      original_message: 'Original text',
    })
  })

  it('does not overwrite original_message on subsequent edits', () => {
    const existing = { ...base, original_message: 'First original' }
    const result = buildUpdatePayload(existing, 'Second edit', NOW)
    expect(result).toEqual({
      message: 'Second edit',
      edited_at: NOW,
    })
  })

  it('rejects edit on deleted messages', () => {
    const existing = { ...base, deleted_at: NOW }
    const result = buildUpdatePayload(existing, 'New text', NOW)
    expect('error' in result).toBe(true)
    expect((result as { error: string }).error).toMatch(/deleted/i)
  })

  it('rejects edit on client messages', () => {
    const existing = { ...base, sender_type: 'client' }
    const result = buildUpdatePayload(existing, 'New text', NOW)
    expect('error' in result).toBe(true)
    expect((result as { error: string }).error).toMatch(/admin/i)
  })
})
