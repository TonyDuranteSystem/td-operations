import { describe, it, expect } from 'vitest'
import {
  parseMentionHandles,
  mentionsClaude,
  shouldAutoContinueWithClaude,
  dmKey,
  channelSlug,
  validateHexColor,
  validateTeamCard,
  CLAUDE_MENTION_ID,
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
