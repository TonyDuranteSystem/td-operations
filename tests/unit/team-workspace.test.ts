import { describe, it, expect } from 'vitest'
import {
  parseMentionHandles,
  mentionsClaude,
  shouldAutoContinueWithClaude,
  dmKey,
  otherDmParty,
  channelSlug,
  validateHexColor,
  validateTeamCard,
  CLAUDE_MENTION_ID,
  CLAUDE_SENDER_UUID,
  isValidWorkStatus,
  TEAM_WORK_STATUSES,
  TEAM_WORK_STATUS_LABELS,
  isStaffAuthRole,
  NON_STAFF_AUTH_ROLES,
} from '@/lib/team/workspace'

describe('work status', () => {
  it('accepts the four valid statuses', () => {
    for (const s of TEAM_WORK_STATUSES) expect(isValidWorkStatus(s)).toBe(true)
  })
  it('rejects anything else', () => {
    expect(isValidWorkStatus('done')).toBe(false)
    expect(isValidWorkStatus('')).toBe(false)
    expect(isValidWorkStatus(null)).toBe(false)
    expect(isValidWorkStatus(5)).toBe(false)
  })
  it('has a label for every status', () => {
    for (const s of TEAM_WORK_STATUSES) expect(TEAM_WORK_STATUS_LABELS[s]).toBeTruthy()
  })
  it('order is todo → in_progress → waiting → handled', () => {
    expect(TEAM_WORK_STATUSES).toEqual(['todo', 'in_progress', 'waiting', 'handled'])
  })
})

describe('parseMentionHandles', () => {
  it('extracts a single mention', () => {
    expect(parseMentionHandles('hey @luca can you check')).toEqual(['luca'])
  })

  it('extracts multiple distinct mentions and de-dupes', () => {
    expect(parseMentionHandles('@luca @claude @luca again')).toEqual(['luca', 'claude'])
  })

  it('handles dotted handles', () => {
    expect(parseMentionHandles('ping @antonio.durante please')).toEqual(['antonio.durante'])
  })

  it('does NOT treat an email address as a mention', () => {
    expect(parseMentionHandles('write to a@b.com now')).toEqual([])
  })

  it('matches a mention at the very start of the string', () => {
    expect(parseMentionHandles('@claude status?')).toEqual(['claude'])
  })

  it('trims trailing punctuation from a handle', () => {
    expect(parseMentionHandles('thanks @luca.')).toEqual(['luca'])
  })

  it('returns empty for empty/no-mention input', () => {
    expect(parseMentionHandles('')).toEqual([])
    expect(parseMentionHandles('no mentions here')).toEqual([])
  })

  it('is case-insensitive and lowercases', () => {
    expect(parseMentionHandles('@Claude @LUCA')).toEqual(['claude', 'luca'])
  })
})

describe('mentionsClaude', () => {
  it('detects @claude', () => {
    expect(mentionsClaude('hey @claude look into this')).toBe(true)
  })
  it('detects @ai alias', () => {
    expect(mentionsClaude('@ai summarize')).toBe(true)
  })
  it('is false without a claude mention', () => {
    expect(mentionsClaude('@luca handle it')).toBe(false)
  })
  it('CLAUDE_MENTION_ID constant is claude', () => {
    expect(CLAUDE_MENTION_ID).toBe('claude')
  })
})

describe('shouldAutoContinueWithClaude (Slack invitation-gate parity)', () => {
  it('explicit mention always triggers, in any thread type', () => {
    expect(shouldAutoContinueWithClaude({ threadType: 'channel', claudeHasParticipated: false, bodyMentionsClaude: true })).toBe(true)
    expect(shouldAutoContinueWithClaude({ threadType: 'discussion', claudeHasParticipated: false, bodyMentionsClaude: true })).toBe(true)
  })
  it('plain message in a discussion continues once Claude has participated', () => {
    expect(shouldAutoContinueWithClaude({ threadType: 'discussion', claudeHasParticipated: true, bodyMentionsClaude: false })).toBe(true)
  })
  it('plain message in a discussion with NO prior Claude participation does not trigger', () => {
    expect(shouldAutoContinueWithClaude({ threadType: 'discussion', claudeHasParticipated: false, bodyMentionsClaude: false })).toBe(false)
  })
  it('plain messages in channels/general/DMs never auto-trigger, even after participation', () => {
    for (const threadType of ['channel', 'general', 'dm']) {
      expect(shouldAutoContinueWithClaude({ threadType, claudeHasParticipated: true, bodyMentionsClaude: false })).toBe(false)
    }
  })
})

describe('dmKey', () => {
  it('is order-independent', () => {
    expect(dmKey('bbb', 'aaa')).toBe(dmKey('aaa', 'bbb'))
  })
  it('sorts the pair', () => {
    expect(dmKey('bbb', 'aaa')).toBe('aaa:bbb')
  })
  it('allows self-dm', () => {
    expect(dmKey('aaa', 'aaa')).toBe('aaa:aaa')
  })
  it('throws when an id is missing', () => {
    expect(() => dmKey('', 'x')).toThrow()
    expect(() => dmKey('x', '')).toThrow()
  })
})

// Bug-hunter, 2026-09-05: a real production message sent via team_chat_send's
// dm_user_id path was permanently invisible to the staff member who dictated
// it (Antonio), because the DM was always keyed to the Claude sentinel rather
// than the real acting user — see lib/team/post-message.ts's
// resolveTargetThread for the fix. This is the OTHER half of that same fix:
// once a dictated DM's dm_key can be "actingUser:target" instead of always
// "Claude:target", naively excluding only the sentinel to find "the other
// participant" (for push targeting) could return the ACTOR instead of the
// real recipient.
describe('otherDmParty — finding who a dictated DM actually goes to', () => {
  it('old shape: Claude-keyed thread, excluding just the sentinel finds the real recipient', () => {
    const key = dmKey(CLAUDE_SENDER_UUID, 'luca')
    expect(otherDmParty(key, [CLAUDE_SENDER_UUID, null])).toBe('luca')
  })

  it('new shape: actor-keyed thread — excluding ONLY the sentinel would wrongly return the actor; excluding both finds the real recipient', () => {
    const key = dmKey('antonio', 'luca')
    // The regression this test pins: with only the sentinel excluded (the
    // pre-fix behaviour), neither half is the sentinel, so .find() would
    // return whichever id sorts first — 'antonio', the actor, not 'luca'.
    expect(otherDmParty(key, [CLAUDE_SENDER_UUID])).toBe('antonio')
    // The actual fix: excluding the acting user too finds the real recipient.
    expect(otherDmParty(key, [CLAUDE_SENDER_UUID, 'antonio'])).toBe('luca')
  })

  it('self-DM: the actor dictated a note to themselves — nobody is pushed', () => {
    const key = dmKey('antonio', 'antonio')
    expect(otherDmParty(key, [CLAUDE_SENDER_UUID, 'antonio'])).toBeNull()
  })

  it('tolerates a null/empty key and an all-null exclude list', () => {
    expect(otherDmParty(null, [])).toBeNull()
    expect(otherDmParty('', [null, undefined])).toBeNull()
  })
})

describe('channelSlug', () => {
  it('lower-cases and hyphenates spaces', () => {
    expect(channelSlug('Daily Ops')).toBe('daily-ops')
  })
  it('strips punctuation', () => {
    expect(channelSlug('Tax Season 2026!')).toBe('tax-season-2026')
  })
  it('collapses repeats and trims hyphens', () => {
    expect(channelSlug('  --Foo___Bar--  ')).toBe('foo-bar')
  })
  it('returns empty for garbage', () => {
    expect(channelSlug('!!!')).toBe('')
    expect(channelSlug('')).toBe('')
  })
  it('caps length at 60', () => {
    expect(channelSlug('a'.repeat(100)).length).toBe(60)
  })
})

describe('validateHexColor', () => {
  it('accepts 6-digit hex', () => {
    expect(validateHexColor('#6366f1')).toBeNull()
  })
  it('accepts 3-digit hex', () => {
    expect(validateHexColor('#abc')).toBeNull()
  })
  it('treats empty as acceptable (color optional)', () => {
    expect(validateHexColor('')).toBeNull()
  })
  it('rejects non-hex', () => {
    expect(validateHexColor('red')).not.toBeNull()
    expect(validateHexColor('#12345')).not.toBeNull()
  })
})

describe('validateTeamCard', () => {
  it('accepts a minimal valid card', () => {
    expect(validateTeamCard({ kind: 'account', title: 'Uxio Test LLC' })).toBeNull()
  })
  it('accepts null (no card)', () => {
    expect(validateTeamCard(null)).toBeNull()
  })
  it('rejects an unknown kind', () => {
    expect(validateTeamCard({ kind: 'nope', title: 'x' })).not.toBeNull()
  })
  it('requires a title', () => {
    expect(validateTeamCard({ kind: 'task', title: '' })).not.toBeNull()
  })
  it('rejects a bad color', () => {
    expect(validateTeamCard({ kind: 'link', title: 'x', color: 'blue' })).not.toBeNull()
  })
  it('accepts a good color', () => {
    expect(validateTeamCard({ kind: 'invoice', title: 'INV-000123', color: '#10b981' })).toBeNull()
  })
  it("NOTE: validateTeamCard accepting this kind is NOT authorization — the message POST refuses a client-posted email_confirm card (see the route). The card's guarantee is 'what you read is what is sent', which only holds if the server wrote it.", () => {
    expect(true).toBe(true)
  })

  it("accepts the 'email_confirm' card — the confirm step Team Chat renders", () => {
    // Antonio 2026-07-29: "I want the confirm step everywhere." If the validator
    // ever stops accepting this kind, the @claude trigger's card write is rejected
    // and a frozen email sits with NO way to confirm it — an email that can never
    // be sent, with the worker having said it was ready.
    expect(
      validateTeamCard({
        kind: 'email_confirm',
        title: 'Confirm email to accountant@example.com',
        subtitle: 'Tax docs — 📎 form1120.pdf',
        entity_type: 'worker_prepared_send',
        entity_id: '3f1b1a4e-0000-4000-8000-000000000000',
        body: 'Hi, please find the documents attached.',
      }),
    ).toBeNull()
  })
})

describe('isStaffAuthRole — who counts as TD staff', () => {
  // THE INCIDENT (production, 2026-07-22): the staff directory excluded only
  // 'client' and then relabelled every survivor 'admin'|'team', so a PARTNER
  // came back as staff and was offered for @mentions, DMs, thread assignment,
  // share targets and staff sticky-note sharing (which pushes the note body).
  // These are the REAL role values from production auth, not invented ones.
  it('THE BUG: a partner is NOT staff', () => {
    expect(isStaffAuthRole('partner')).toBe(false)
  })

  it('a client is not staff', () => {
    expect(isStaffAuthRole('client')).toBe(false)
  })

  it('admin and team are staff', () => {
    expect(isStaffAuthRole('admin')).toBe(true)
    expect(isStaffAuthRole('team')).toBe(true)
  })

  it('is case-insensitive, so a stray capital cannot readmit a partner', () => {
    expect(isStaffAuthRole('Partner')).toBe(false)
    expect(isStaffAuthRole('CLIENT')).toBe(false)
  })

  it('treats an absent role as staff — legacy accounts predate the field', () => {
    // Documents the deliberate deny-list trade-off: this preserves the old
    // `role !== "client"` behaviour for accounts with no role set.
    expect(isStaffAuthRole(null)).toBe(true)
    expect(isStaffAuthRole(undefined)).toBe(true)
    expect(isStaffAuthRole('')).toBe(true)
  })

  it('every listed non-staff role is rejected', () => {
    for (const role of NON_STAFF_AUTH_ROLES) {
      expect(isStaffAuthRole(role)).toBe(false)
    }
  })

  it('names partner explicitly, so removing it from the list is a visible change', () => {
    expect(NON_STAFF_AUTH_ROLES).toContain('partner')
    expect(NON_STAFF_AUTH_ROLES).toContain('client')
  })
})
