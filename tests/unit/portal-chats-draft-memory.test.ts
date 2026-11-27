// Portal Chats draft memory (dev job f1f72ce2, 2026-11-27): a reply typed in a conversation must survive leaving it and coming back, including when
// React runs the restore effect's cleanup right after the restore (it does so once after every mount in development / strict mode).
// These tests run the real restore / save helpers through the same sequence the page's effect performs.
import { describe, it, expect } from 'vitest'
import { draftSnapshotFor, persistClientDraft, restoreClientDraft, type DraftSnapshot } from '@/lib/portal-chats/draft-memory'

type Msg = { id: string }
type Snap = DraftSnapshot<Msg, string>

/** A tiny stand-in for the page: the in-memory map, the browser storage, and the snapshot ref the page refreshes after every render. */
function makePage() {
  const map = new Map<string, Snap>()
  const storage = new Map<string, { replyText: string; replyToMsg: Msg | null }>()
  const snapshotRef: { current: Snap } = { current: draftSnapshotFor<Msg, string>(null) }
  const load = (key: string) => storage.get(key) ?? null
  const save = (key: string, entry: { replyText: string; replyToMsg: Msg | null }) => {
    if (!entry.replyText.trim()) storage.delete(key)
    else storage.set(key, entry)
  }
  /** What the page's restore effect does for `key`; `fixed` = it also puts the restored draft into the snapshot ref. Returns the cleanup. */
  const openEffect = (key: string | null, fixed: boolean) => {
    const restored = restoreClientDraft(key, map, load)
    if (fixed) snapshotRef.current = restored
    return { restored, cleanup: () => persistClientDraft(key, map, snapshotRef.current, save) }
  }
  /** The page's next render: the box shows `text`, and the snapshot ref is refreshed from it (what the no-dependency effect does). */
  const render = (text: string) => { snapshotRef.current = draftSnapshotFor<Msg, string>({ replyText: text }) }
  return { map, storage, snapshotRef, openEffect, render }
}

describe('restoring a draft', () => {
  it('uses the in-memory draft, else the saved one (and remembers it), else an empty box', () => {
    const p = makePage()
    p.map.set('A', { replyText: 'in memory', replyToMsg: null, pendingAdminFiles: [] })
    p.storage.set('B', { replyText: 'in storage', replyToMsg: { id: 'm1' } })
    expect(restoreClientDraft('A', p.map, () => ({ replyText: 'ignored', replyToMsg: null })).replyText).toBe('in memory')
    const b = restoreClientDraft('B', p.map, k => p.storage.get(k) ?? null)
    expect(b.replyText).toBe('in storage')
    expect(b.replyToMsg).toEqual({ id: 'm1' })
    expect(p.map.get('B')?.replyText).toBe('in storage')
    expect(restoreClientDraft('C', p.map, () => null)).toEqual({ replyText: '', replyToMsg: null, pendingAdminFiles: [] })
    expect(restoreClientDraft(null, p.map, () => { throw new Error('must not look anything up without a conversation') }).replyText).toBe('')
  })

  it('hands back a copy, so changing the box never edits the saved entry', () => {
    const p = makePage()
    p.map.set('A', { replyText: 'x', replyToMsg: null, pendingAdminFiles: ['f1'] })
    const r = restoreClientDraft('A', p.map, () => null)
    r.pendingAdminFiles.push('f2')
    expect(p.map.get('A')?.pendingAdminFiles).toEqual(['f1'])
  })
})

describe('saving a draft', () => {
  it('saves in memory and in storage; no conversation open saves nothing; an emptied box removes the stored draft', () => {
    const p = makePage()
    persistClientDraft('A', p.map, { replyText: 'hello', replyToMsg: null, pendingAdminFiles: [] }, (k, e) => p.storage.set(k, e))
    expect(p.map.get('A')?.replyText).toBe('hello')
    expect(p.storage.get('A')?.replyText).toBe('hello')
    persistClientDraft(null, p.map, { replyText: 'nowhere', replyToMsg: null, pendingAdminFiles: [] }, (k, e) => p.storage.set(k, e))
    expect(p.map.size).toBe(1)
    expect(p.storage.size).toBe(1)
  })
})

describe('the strict-mode sequence: restore, an immediate cleanup, restore again', () => {
  it('BEFORE the fix the stored draft was erased and the box came up empty (what the browser test showed)', () => {
    const p = makePage()
    p.storage.set('A', { replyText: 'half a sentence', replyToMsg: null })
    // fresh page: the snapshot ref starts empty; the page does NOT put the restored draft into it
    const run1 = p.openEffect('A', false)
    expect(run1.restored.replyText).toBe('half a sentence')
    run1.cleanup() // React's immediate cleanup saves the stale, empty snapshot over the draft
    expect(p.storage.has('A')).toBe(false)
    const run2 = p.openEffect('A', false)
    expect(run2.restored.replyText).toBe('') // lost
  })

  it('AFTER the fix the draft survives the immediate cleanup and is restored again', () => {
    const p = makePage()
    p.storage.set('A', { replyText: 'half a sentence', replyToMsg: { id: 'm9' } })
    const run1 = p.openEffect('A', true)
    run1.cleanup()
    expect(p.storage.get('A')?.replyText).toBe('half a sentence')
    const run2 = p.openEffect('A', true)
    expect(run2.restored.replyText).toBe('half a sentence')
    expect(run2.restored.replyToMsg).toEqual({ id: 'm9' })
  })

  it('switching A -> B: the cleanup in the gap never saves A\'s words under B', () => {
    const p = makePage()
    p.storage.set('B', { replyText: 'B draft', replyToMsg: null })
    // A is open and the box holds A's words
    const a = p.openEffect('A', true)
    p.render('A words')
    // switch: A's cleanup, then B's restore
    a.cleanup()
    const b1 = p.openEffect('B', true)
    b1.cleanup() // the immediate cleanup in the gap
    expect(p.storage.get('A')?.replyText).toBe('A words')
    expect(p.storage.get('B')?.replyText).toBe('B draft')
    const b2 = p.openEffect('B', true)
    expect(b2.restored.replyText).toBe('B draft')
  })

  it('without the fix the same switch saved A\'s words under B (the second, worse symptom)', () => {
    const p = makePage()
    const a = p.openEffect('A', false)
    p.render('A words')
    a.cleanup()
    const b1 = p.openEffect('B', false)
    b1.cleanup()
    expect(p.storage.get('B')?.replyText).toBe('A words')
  })

  it('normal use is unchanged: type, leave, come back, the words are there; clear the box and leave, nothing is kept', () => {
    const p = makePage()
    let open = p.openEffect('A', true)
    p.render('typing something')
    open.cleanup()
    open = p.openEffect('A', true)
    expect(open.restored.replyText).toBe('typing something')
    p.render('')
    open.cleanup()
    expect(p.storage.has('A')).toBe(false)
    expect(p.openEffect('A', true).restored.replyText).toBe('')
  })
})

describe('the page uses the helpers and keeps the snapshot in step', () => {
  // wiring check only; the behaviour is tested above
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('node:fs') as typeof import('node:fs')
  const page = fs.readFileSync('app/(dashboard)/portal-chats/page.tsx', 'utf8')

  it('the client composer restores through restoreClientDraft and puts the result into the snapshot ref', () => {
    expect(page).toContain('const restored = restoreClientDraft(clientThreadKey, draftsMap, loadPersistedChatDraft)')
    expect(page).toContain('clientDraftSnapshotRef.current = restored')
    expect(page).toContain('persistClientDraft(clientThreadKey, draftsMap, clientDraftSnapshotRef.current, savePersistedChatDraft)')
  })

  it('the team composer does the same for its own snapshot', () => {
    expect(page).toContain('internalDraftSnapshotRef.current = { internalReplyText: saved?.internalReplyText ?? \'\', internalPendingFile: saved?.internalPendingFile ?? null }')
  })
})
