/**
 * Client-key parsing for the client card (dev job 17459c25).
 *
 * Two naming conventions for "which client" exist side by side in this codebase:
 *   "acct-<id>"    / "contact-<id>"   — Inbox and Portal Chats panels
 *   "account:<id>" / "contact:<id>"   — dashboard sidebar (sidebar-scope) and client-scope
 *
 * The card builder originally understood only the first. Given the second it sliced
 * "contact-".length characters off "account:<uuid>", producing "t:<uuid>", looked that
 * up as a contact id, found nothing, and returned an EMPTY card. The visible symptom was
 * the assistant insisting no client was loaded while sitting on that client's page — and
 * simultaneously holding a send rail pinned to that same client. Found in sandbox E2E.
 */

import { describe, it, expect } from 'vitest'
import { parseClientKey } from '@/lib/ai-agent/client-card'

const ID = '30c2cd96-03e4-43cf-9536-81d961b18b1d'

describe('parseClientKey', () => {
  it('accepts the Inbox / Portal Chats account form', () => {
    expect(parseClientKey(`acct-${ID}`)).toEqual({ isAccount: true, id: ID })
  })

  it('accepts the sidebar / client-scope account form (the one that used to break)', () => {
    expect(parseClientKey(`account:${ID}`)).toEqual({ isAccount: true, id: ID })
  })

  it('accepts both contact forms', () => {
    expect(parseClientKey(`contact-${ID}`)).toEqual({ isAccount: false, id: ID })
    expect(parseClientKey(`contact:${ID}`)).toEqual({ isAccount: false, id: ID })
  })

  it('REGRESSION: never mangles one form into a garbage id of the other kind', () => {
    // The exact bug: "account:<uuid>" parsed as a CONTACT with id "t:<uuid>".
    const parsed = parseClientKey(`account:${ID}`)!
    expect(parsed.isAccount).toBe(true)
    expect(parsed.id).toBe(ID)
    expect(parsed.id.startsWith('t:')).toBe(false)
  })

  it('returns null for an unrecognised or empty key — no card beats a wrong card', () => {
    for (const bad of ['', '   ', ID, `lead:${ID}`, 'account:', 'contact-', 'garbage']) {
      expect(parseClientKey(bad), bad).toBeNull()
    }
  })
})
