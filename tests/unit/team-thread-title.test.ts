import { describe, it, expect } from 'vitest'
import {
  normalizeThreadTitle,
  resolveThreadTitle,
  threadStateIsMeaningful,
  THREAD_TITLE_MAX,
} from '@/lib/team/thread-title'

describe('normalizeThreadTitle', () => {
  it('trims a normal name', () => {
    expect(normalizeThreadTitle('  Inbox is slow  ')).toEqual({ title: 'Inbox is slow' })
  })

  it('collapses newlines and runs of whitespace to single spaces', () => {
    expect(normalizeThreadTitle('Inbox\n\nis   slow')).toEqual({ title: 'Inbox is slow' })
  })

  it('treats blank input as CLEARING the name', () => {
    expect(normalizeThreadTitle('')).toEqual({ title: null })
    expect(normalizeThreadTitle('   ')).toEqual({ title: null })
    expect(normalizeThreadTitle('\n\t')).toEqual({ title: null })
    expect(normalizeThreadTitle(null)).toEqual({ title: null })
  })

  it('rejects a name past the limit', () => {
    const long = 'x'.repeat(THREAD_TITLE_MAX + 1)
    expect(normalizeThreadTitle(long)).toEqual({ error: expect.stringContaining(String(THREAD_TITLE_MAX)) })
  })

  it('accepts a name exactly at the limit', () => {
    const exact = 'x'.repeat(THREAD_TITLE_MAX)
    expect(normalizeThreadTitle(exact)).toEqual({ title: exact })
  })

  it('rejects non-text input', () => {
    expect(normalizeThreadTitle(42)).toEqual({ error: expect.any(String) })
    expect(normalizeThreadTitle({})).toEqual({ error: expect.any(String) })
    expect(normalizeThreadTitle(undefined)).toEqual({ error: expect.any(String) })
  })
})

describe('resolveThreadTitle', () => {
  it('prefers the explicit name', () => {
    expect(resolveThreadTitle({ stateTitle: 'Banking bug', rootMessage: 'hey can someone look' }))
      .toBe('Banking bug')
  })

  it('falls back to the opening message when unnamed', () => {
    expect(resolveThreadTitle({ stateTitle: null, rootMessage: 'hey can someone look' }))
      .toBe('hey can someone look')
  })

  it('keeps the NAME even when the opening message was deleted', () => {
    expect(resolveThreadTitle({ stateTitle: 'Banking bug', rootMessage: 'x', rootDeleted: true }))
      .toBe('Banking bug')
  })

  it('shows a tombstone for an unnamed thread whose opening message was deleted', () => {
    expect(resolveThreadTitle({ stateTitle: null, rootMessage: 'secret', rootDeleted: true }))
      .toBe('Message deleted')
  })

  it('ignores a whitespace-only stored name', () => {
    expect(resolveThreadTitle({ stateTitle: '   ', rootMessage: 'body' })).toBe('body')
  })

  // These exact strings are also emitted by the SQL resolvers in
  // 20260718-1400-thread-rename-archive.sql. If one side changes, this test is
  // what catches the drift — an earlier version returned '📎 Attachment' here
  // while SQL returned 'Attachment', labelling one thread two ways.
  it('labels an attachment-only opening message identically to the SQL copies', () => {
    expect(resolveThreadTitle({ stateTitle: null, rootMessage: '' })).toBe('Attachment')
    expect(resolveThreadTitle({ stateTitle: null, rootMessage: null })).toBe('Attachment')
  })

  it('emits the same tombstone literal as the SQL copies', () => {
    expect(resolveThreadTitle({ stateTitle: null, rootMessage: 'x', rootDeleted: true })).toBe('Message deleted')
  })
})

describe('threadStateIsMeaningful', () => {
  it('treats an untouched default row as meaningless', () => {
    expect(threadStateIsMeaningful({ status: 'todo', assignee_id: null, title: null, created_as_thread: false, archived_at: null })).toBe(false)
  })

  it('treats a missing row as meaningless', () => {
    expect(threadStateIsMeaningful(null)).toBe(false)
    expect(threadStateIsMeaningful(undefined)).toBe(false)
  })

  it('counts a name, an archive, an assignee, a non-default status, or a deliberate creation', () => {
    expect(threadStateIsMeaningful({ status: 'todo', title: 'Banking bug' })).toBe(true)
    expect(threadStateIsMeaningful({ status: 'todo', archived_at: '2026-07-18T00:00:00Z' })).toBe(true)
    expect(threadStateIsMeaningful({ status: 'todo', assignee_id: 'user-2' })).toBe(true)
    expect(threadStateIsMeaningful({ status: 'in_progress' })).toBe(true)
    expect(threadStateIsMeaningful({ status: 'todo', created_as_thread: true })).toBe(true)
  })

  it('ignores a whitespace-only title (that is not a name)', () => {
    expect(threadStateIsMeaningful({ status: 'todo', title: '   ' })).toBe(false)
  })

  // The restore path leaves the row behind on purpose; it must not strand a
  // stray message on the board as a phantom thread.
  it('treats a restored-from-archive row with nothing else set as meaningless', () => {
    expect(threadStateIsMeaningful({ status: 'todo', assignee_id: null, title: null, created_as_thread: false, archived_at: null })).toBe(false)
  })
})
