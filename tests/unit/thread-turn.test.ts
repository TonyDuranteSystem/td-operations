import { describe, it, expect } from 'vitest'
import { computeThreadTurn, type ComputeTurnArgs } from '@/lib/team/thread-turn'

const VIEWER = 'antonio'
const OTHER = 'luca'
const AI = 'ai-0000'

function base(partial: Partial<ComputeTurnArgs>): ComputeTurnArgs {
  return {
    lastByRoot: new Map(),
    viewerId: VIEWER,
    aiSenderId: AI,
    readsByRoot: new Map(),
    participantsByRoot: new Map(),
    nameById: new Map([[OTHER, 'Luca'], [VIEWER, 'Antonio']]),
    ...partial,
  }
}

describe('computeThreadTurn', () => {
  it('incoming + unread by viewer → waiting_you', () => {
    const out = computeThreadTurn(base({
      lastByRoot: new Map([['r1', { sender_id: OTHER, created_at: '2026-07-26T10:00:00Z' }]]),
      readsByRoot: new Map(), // viewer never read
    }))
    expect(out.r1).toEqual({ read_state: 'waiting_you', waiting_name: null })
  })

  it('incoming + read by viewer → none', () => {
    const out = computeThreadTurn(base({
      lastByRoot: new Map([['r1', { sender_id: OTHER, created_at: '2026-07-26T10:00:00Z' }]]),
      readsByRoot: new Map([['r1', new Map([[VIEWER, '2026-07-26T10:05:00Z']])]]),
    }))
    expect(out.r1).toEqual({ read_state: 'none', waiting_name: null })
  })

  it('our message, other has NOT read → waiting_them with name', () => {
    const out = computeThreadTurn(base({
      lastByRoot: new Map([['r1', { sender_id: VIEWER, created_at: '2026-07-26T10:00:00Z' }]]),
      readsByRoot: new Map([['r1', new Map([[VIEWER, '2026-07-26T10:00:00Z']])]]), // only viewer read (their own)
      participantsByRoot: new Map([['r1', new Set([VIEWER, OTHER])]]),
    }))
    expect(out.r1).toEqual({ read_state: 'waiting_them', waiting_name: 'Luca' })
  })

  it('our message, other HAS read → seen', () => {
    const out = computeThreadTurn(base({
      lastByRoot: new Map([['r1', { sender_id: VIEWER, created_at: '2026-07-26T10:00:00Z' }]]),
      readsByRoot: new Map([['r1', new Map([[OTHER, '2026-07-26T10:03:00Z']])]]),
    }))
    expect(out.r1).toEqual({ read_state: 'seen', waiting_name: null })
  })

  it('AI reply counts as OUR side: other not read → waiting_them', () => {
    const out = computeThreadTurn(base({
      lastByRoot: new Map([['r1', { sender_id: AI, created_at: '2026-07-26T10:00:00Z' }]]),
      readsByRoot: new Map(),
      participantsByRoot: new Map([['r1', new Set([OTHER, AI])]]),
    }))
    expect(out.r1).toEqual({ read_state: 'waiting_them', waiting_name: 'Luca' })
  })

  it('AI reply, other HAS read → seen', () => {
    const out = computeThreadTurn(base({
      lastByRoot: new Map([['r1', { sender_id: AI, created_at: '2026-07-26T10:00:00Z' }]]),
      readsByRoot: new Map([['r1', new Map([[OTHER, '2026-07-26T11:00:00Z']])]]),
    }))
    expect(out.r1.read_state).toBe('seen')
  })

  it('the AI read pointer never counts as the other side (AI has no read pointer normally, but guard anyway)', () => {
    const out = computeThreadTurn(base({
      lastByRoot: new Map([['r1', { sender_id: VIEWER, created_at: '2026-07-26T10:00:00Z' }]]),
      readsByRoot: new Map([['r1', new Map([[AI, '2026-07-26T10:30:00Z']])]]), // only the AI "read" it
      participantsByRoot: new Map([['r1', new Set([VIEWER, OTHER])]]),
    }))
    expect(out.r1.read_state).toBe('waiting_them')
  })

  it('the viewer reading their OWN message does not count as seen', () => {
    const out = computeThreadTurn(base({
      lastByRoot: new Map([['r1', { sender_id: VIEWER, created_at: '2026-07-26T10:00:00Z' }]]),
      readsByRoot: new Map([['r1', new Map([[VIEWER, '2026-07-26T12:00:00Z']])]]),
      participantsByRoot: new Map([['r1', new Set([VIEWER, OTHER])]]),
    }))
    expect(out.r1.read_state).toBe('waiting_them')
  })

  it('read pointer strictly before the message → not seen', () => {
    const out = computeThreadTurn(base({
      lastByRoot: new Map([['r1', { sender_id: VIEWER, created_at: '2026-07-26T10:00:00Z' }]]),
      readsByRoot: new Map([['r1', new Map([[OTHER, '2026-07-26T09:59:59Z']])]]), // read an earlier reply, not this one
      participantsByRoot: new Map([['r1', new Set([VIEWER, OTHER])]]),
    }))
    expect(out.r1.read_state).toBe('waiting_them')
  })

  it('waiting_them with no known participant name → null name (state still set)', () => {
    const out = computeThreadTurn(base({
      lastByRoot: new Map([['r1', { sender_id: VIEWER, created_at: '2026-07-26T10:00:00Z' }]]),
      readsByRoot: new Map(),
      participantsByRoot: new Map(), // brand-new root, other side hasn't participated yet
    }))
    expect(out.r1).toEqual({ read_state: 'waiting_them', waiting_name: null })
  })

  it('mixed ISO formats compare as instants: Postgres +00:00 read vs JS Z message → seen', () => {
    const out = computeThreadTurn(base({
      lastByRoot: new Map([['r1', { sender_id: VIEWER, created_at: '2026-07-26T10:00:00.000Z' }]]),
      // read pointer serialized the Postgres way, a second later → must count as seen
      readsByRoot: new Map([['r1', new Map([[OTHER, '2026-07-26T10:00:01.000000+00:00']])]]),
    }))
    expect(out.r1.read_state).toBe('seen')
  })

  it('mixed ISO formats: read strictly before the message (different shapes) → not seen', () => {
    const out = computeThreadTurn(base({
      lastByRoot: new Map([['r1', { sender_id: VIEWER, created_at: '2026-07-26T10:00:01.000000+00:00' }]]),
      readsByRoot: new Map([['r1', new Map([[OTHER, '2026-07-26T10:00:00.000Z']])]]),
      participantsByRoot: new Map([['r1', new Set([VIEWER, OTHER])]]),
    }))
    expect(out.r1.read_state).toBe('waiting_them')
  })

  it('unparseable read pointer → treated as not read', () => {
    const out = computeThreadTurn(base({
      lastByRoot: new Map([['r1', { sender_id: VIEWER, created_at: '2026-07-26T10:00:00Z' }]]),
      readsByRoot: new Map([['r1', new Map([[OTHER, 'not-a-date']])]]),
      participantsByRoot: new Map([['r1', new Set([VIEWER, OTHER])]]),
    }))
    expect(out.r1.read_state).toBe('waiting_them')
  })

  it('empty input → empty output', () => {
    expect(computeThreadTurn(base({}))).toEqual({})
  })

  it('handles many roots independently', () => {
    const out = computeThreadTurn(base({
      lastByRoot: new Map([
        ['r1', { sender_id: OTHER, created_at: '2026-07-26T10:00:00Z' }],   // waiting_you
        ['r2', { sender_id: VIEWER, created_at: '2026-07-26T10:00:00Z' }],  // waiting_them
      ]),
      readsByRoot: new Map([['r2', new Map([[OTHER, '2026-07-26T11:00:00Z']])]]), // r2 seen
      participantsByRoot: new Map([['r2', new Set([VIEWER, OTHER])]]),
    }))
    expect(out.r1.read_state).toBe('waiting_you')
    expect(out.r2.read_state).toBe('seen')
  })
})
