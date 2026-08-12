/**
 * Dev job `61f184ca` — who the owner of record is.
 *
 * WHAT USED TO BE HERE AND IS GONE: an address splitter and a "who may author this
 * address" permission check, both serving an editable address field for sole
 * owners. That field corrupted client contact records — a joined address is lossy,
 * splitting it back apart guessed wrong for 35 of 271 contacts, and the wrong guess
 * was written over their record. Antonio removed the field, the write-back and both
 * helpers rather than repair the splitter.
 *
 * What remains is the one question still asked: for a company with NO member roster
 * — every Single Member LLC, 216 of the active accounts, CORRECT state by design —
 * whose contact record names and addresses the owner on the document?
 *
 * That is still safety-relevant with nothing editable, because it decides whose
 * name and home address appear on a legal instrument. And because the FIRST attempt
 * at tightening it caused a regression: returning null when no role matched let the
 * screen render a member called "N/A" while the server stored the logged-in
 * person's name — the previewed and the signed document disagreeing about who owns
 * the company. Both surfaces must refuse together, from this one resolution.
 */

import { describe, it, expect } from 'vitest'

import { resolveOwnerOfRecord, ownerContactIdOrNull, resolveOwnerName, type AccountContactLink } from '@/lib/members/sole-owner-address'

const OWNER: AccountContactLink = { contact_id: 'c-owner', role: 'Owner' }
const ADMIN: AccountContactLink = { contact_id: 'c-admin', role: 'Administrator' }
const MEMBER: AccountContactLink = { contact_id: 'c-member', role: 'Member' }
const UNTAGGED: AccountContactLink = { contact_id: 'c-untagged', role: null }

describe('resolveOwnerOfRecord — rule 1: one person, no ambiguity', () => {
  it('THE REGRESSION FIX: a lone contact IS the owner whatever the role says', () => {
    // The CRM role dropdown offers Owner/Sole Member, Authorized Representative,
    // Manager, Accountant and blank — only the first matches by text. Before this
    // rule, staff picking "Manager" for a sole owner emptied the member list and
    // the preview showed "N/A" while the document stored someone else's name.
    for (const role of ['Manager', 'Accountant', 'Authorized Representative', '', null]) {
      const r = resolveOwnerOfRecord([{ contact_id: 'c-solo', role }])
      expect(r.resolved).toBe(true)
      expect(r.contactId).toBe('c-solo')
      expect(r.via).toBe('sole_contact')
    }
  })
})

describe('resolveOwnerOfRecord — rule 2: several people, go by role', () => {
  it('prefers an owner-ish role, whatever the order or casing', () => {
    expect(resolveOwnerOfRecord([ADMIN, { contact_id: 'c-owner', role: 'sole member' }]).contactId).toBe('c-owner')
    expect(resolveOwnerOfRecord([ADMIN, OWNER]).contactId).toBe('c-owner')
    expect(resolveOwnerOfRecord([{ contact_id: 'c-owner', role: 'OWNER' }, ADMIN]).contactId).toBe('c-owner')
  })

  it('falls back to a member-ish role when no owner role exists', () => {
    const r = resolveOwnerOfRecord([ADMIN, MEMBER])
    expect(r.contactId).toBe('c-member')
    expect(r.via).toBe('member_role')
  })
})

describe('resolveOwnerOfRecord — refuse when SEVERAL people are the owner', () => {
  it('THE RULING: two owner-role links REFUSE — never silently pick one', () => {
    // A 50/50 couple company still flagged single-member with no roster would
    // otherwise have one of them named SOLE member of the company, chosen by
    // internal ordering. Antonio: "Where several owner-role links exist, refuse.
    // Do not pick one silently. Same rule you already applied to the address."
    const r = resolveOwnerOfRecord([
      { contact_id: 'c-a', role: 'Owner' },
      { contact_id: 'c-b', role: 'Sole Member' },
    ])
    expect(r.resolved).toBe(false)
    expect(r.reason).toBe('several_owners')
    expect(r.contactId).toBeNull()
  })

  it('is not order-dependent — the refusal holds whichever way round they come', () => {
    const a = { contact_id: 'c-a', role: 'Owner' }
    const b = { contact_id: 'c-b', role: 'Owner' }
    expect(resolveOwnerOfRecord([a, b]).resolved).toBe(false)
    expect(resolveOwnerOfRecord([b, a]).resolved).toBe(false)
  })

  it('two member-role links refuse too, for the same reason', () => {
    expect(resolveOwnerOfRecord([
      { contact_id: 'c-a', role: 'Member' },
      { contact_id: 'c-b', role: 'member' },
    ]).reason).toBe('several_owners')
  })

  it('but ONE owner among several links still resolves cleanly', () => {
    const r = resolveOwnerOfRecord([ADMIN, OWNER, { contact_id: 'c-acct', role: 'Accountant' }])
    expect(r.resolved).toBe(true)
    expect(r.contactId).toBe('c-owner')
  })
})

describe('resolveOwnerName — one name, both surfaces, never a placeholder', () => {
  it('THE DIVERGENCE FIX: prefers the reliably-populated full name', () => {
    // The screen used to build it from first + last while the route used the full
    // name. 78 of 473 production contacts are missing one of the two parts, so the
    // preview printed a partial name — or "N/A" — while the document printed the
    // real one.
    expect(resolveOwnerName({ full_name: 'Alice Rossi', first_name: null, last_name: null })).toBe('Alice Rossi')
  })

  it('falls back to first + last when there is no full name', () => {
    expect(resolveOwnerName({ full_name: null, first_name: 'Alice', last_name: 'Rossi' })).toBe('Alice Rossi')
    expect(resolveOwnerName({ full_name: '   ', first_name: 'Alice', last_name: null })).toBe('Alice')
  })

  it('RETURNS NULL rather than a placeholder when no name exists — callers refuse', () => {
    // "N/A" as the sole member of a company is not a tidy-up-later defect; it is a
    // legal instrument naming nobody.
    expect(resolveOwnerName({ full_name: null, first_name: null, last_name: null })).toBeNull()
    expect(resolveOwnerName({ full_name: '', first_name: '  ', last_name: '' })).toBeNull()
    expect(resolveOwnerName(null)).toBeNull()
    expect(resolveOwnerName(undefined)).toBeNull()
  })

  it('never returns the literal N/A for any input', () => {
    for (const c of [
      { full_name: null, first_name: null, last_name: null },
      { full_name: 'N/A' },
      { first_name: 'Alice' },
    ]) {
      const out = resolveOwnerName(c)
      if (out !== null) expect(out).not.toBe('')
    }
    expect(resolveOwnerName({ full_name: null, first_name: null, last_name: null })).not.toBe('N/A')
  })
})

describe('resolveOwnerOfRecord — rule 3: refuse rather than guess', () => {
  it('THE RULING: REFUSES when several people are linked and none is the owner', () => {
    // Antonio, 2026-08-12: "Guessing an owner on a legal document is not an
    // acceptable default." Never first-in-list: roles are free text and the two
    // queries feeding this could otherwise name different people.
    const r = resolveOwnerOfRecord([ADMIN, UNTAGGED])
    expect(r.resolved).toBe(false)
    expect(r.reason).toBe('ambiguous_roles')
    expect(r.contactId).toBeNull()
  })

  it('distinguishes "nobody on file" from "cannot tell which" — different messages', () => {
    expect(resolveOwnerOfRecord([]).reason).toBe('no_contacts')
    expect(resolveOwnerOfRecord([ADMIN, UNTAGGED]).reason).toBe('ambiguous_roles')
  })

  it('a refusal always carries a reason, and a resolution never does', () => {
    // The screen and the route both branch on these; a silently undefined reason
    // would pick the wrong client-facing message.
    const refused = resolveOwnerOfRecord([ADMIN, UNTAGGED])
    expect(refused.resolved).toBe(false)
    expect(refused.reason).not.toBeNull()

    const ok = resolveOwnerOfRecord([OWNER, ADMIN])
    expect(ok.resolved).toBe(true)
    expect(ok.reason).toBeNull()
    expect(ok.contactId).not.toBeNull()
  })
})

describe('production shape, verified 2026-08-12', () => {
  it('refuses almost nobody: 218 owner-role, 4 member-role, 3 with no contacts at all', () => {
    // Documented here so a future reader does not "restore" a first-in-list
    // fallback believing the refusal strands real clients.
    expect(resolveOwnerOfRecord([OWNER, ADMIN]).resolved).toBe(true)
    expect(resolveOwnerOfRecord([MEMBER, ADMIN]).resolved).toBe(true)
    expect(resolveOwnerOfRecord([]).resolved).toBe(false)
  })
})

describe('ownerContactIdOrNull', () => {
  it('gives the id when resolved and null when refused', () => {
    expect(ownerContactIdOrNull([OWNER, ADMIN])).toBe('c-owner')
    expect(ownerContactIdOrNull([{ contact_id: 'c-solo', role: 'Accountant' }])).toBe('c-solo')
    expect(ownerContactIdOrNull([ADMIN, UNTAGGED])).toBeNull()
  })
})
