/**
 * lib/team/post-message.ts — pure input validators for the "post to Team Chat
 * as Claude" choke-point (shared by the MCP tool + the AI worker tool).
 */

import { describe, it, expect } from 'vitest'
import { validateTeamPostTarget, validateTeamPostMessage, TEAM_MESSAGE_MAX } from '@/lib/team/post-message-validate'

describe('validateTeamPostTarget', () => {
  it('accepts exactly one target', () => {
    expect(validateTeamPostTarget({ channel: 'td-dev' })).toBeNull()
    expect(validateTeamPostTarget({ thread_id: 't1' })).toBeNull()
    expect(validateTeamPostTarget({ dm_user_id: 'u1' })).toBeNull()
  })
  it('rejects no target', () => {
    expect(validateTeamPostTarget({})).toMatch(/target is required/i)
    expect(validateTeamPostTarget({ channel: '  ', thread_id: '', dm_user_id: null })).toMatch(/target is required/i)
  })
  it('rejects more than one target', () => {
    expect(validateTeamPostTarget({ channel: 'td-dev', thread_id: 't1' })).toMatch(/exactly one/i)
    expect(validateTeamPostTarget({ channel: 'td-dev', dm_user_id: 'u1' })).toMatch(/exactly one/i)
  })
})

describe('validateTeamPostMessage', () => {
  it('requires a non-empty message', () => {
    expect(validateTeamPostMessage('')).toMatch(/message is required/i)
    expect(validateTeamPostMessage('   ')).toMatch(/message is required/i)
  })
  it('accepts a normal message', () => {
    expect(validateTeamPostMessage('Hi @Luca, the fix is live.')).toBeNull()
  })
  it('rejects an over-long message', () => {
    expect(validateTeamPostMessage('x'.repeat(TEAM_MESSAGE_MAX + 1))).toMatch(/too long/i)
    expect(validateTeamPostMessage('x'.repeat(TEAM_MESSAGE_MAX))).toBeNull()
  })
  it('rejects an invalid card but accepts none', () => {
    expect(validateTeamPostMessage('hi', null)).toBeNull()
    expect(validateTeamPostMessage('hi', { kind: 'link' })).toBeTruthy() // missing required card fields
  })
})
