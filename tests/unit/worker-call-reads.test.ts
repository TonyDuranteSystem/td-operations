import { describe, it, expect } from 'vitest'
import {
  renderCallDetail,
  executeWorkerTool,
  WORKER_TOOLS,
  LIST_CALLS_TOOL,
  GET_CALL_TOOL,
  SEARCH_CALLS_TOOL,
} from '@/lib/ai-agent/worker-tools'

function makeCall(transcriptTurns: number) {
  return {
    id: 'call-1',
    meeting_name: 'Formation kickoff',
    created_at: '2026-06-10T15:00:00Z',
    duration_seconds: 1800,
    recording_url: 'https://app.circleback.ai/rec/abc',
    lead_id: null,
    account_id: 'acct-1',
    tags: ['intake'],
    attendees: [{ name: 'Antonio', email: 'antonio@tonydurante.us' }, { name: 'Client' }],
    notes: 'Discussed LLC formation and EIN timeline.',
    action_items: [
      { text: 'Send formation form', assignee: 'Luca' },
      { text: 'Book bank appointment', assignee: { name: 'Antonio Durante', email: 'antonio@tonydurante.us' } },
      'Follow up next week',
    ],
    transcript: Array.from({ length: transcriptTurns }, (_, i) => ({
      speaker: i % 2 === 0 ? 'Antonio' : 'Client',
      text: `Turn number ${i} of the conversation.`,
    })),
  }
}

describe('renderCallDetail', () => {
  it('renders notes, action items, attendees and the FULL transcript (no 50-turn cap)', () => {
    const out = renderCallDetail(makeCall(120))
    expect(out).toContain('Formation kickoff')
    expect(out).toContain('── Notes ──')
    expect(out).toContain('EIN timeline')
    expect(out).toContain('── Action Items ──')
    expect(out).toContain('Send formation form (@Luca)')
    // Object-shaped assignee { name, email } renders the name, not "[object Object]".
    expect(out).toContain('Book bank appointment (@Antonio Durante)')
    expect(out).not.toContain('[object Object]')
    // Full transcript: header reports all turns and the LAST turn is present (would be
    // hidden by the old 50-entry MCP cap).
    expect(out).toContain('── Transcript (120 turns) ──')
    expect(out).toContain('Turn number 119 of the conversation.')
    expect(out).toContain('[Client]:')
  })

  it('handles a call with no transcript gracefully', () => {
    const call = makeCall(0)
    const out = renderCallDetail(call)
    expect(out).toContain('(No transcript stored for this call.)')
  })

  it('truncates pathologically long transcripts and points to the recording', () => {
    const out = renderCallDetail(makeCall(6000))
    expect(out).toContain('…(truncated at')
    expect(out).toContain('https://app.circleback.ai/rec/abc')
    expect(out.length).toBeLessThan(121_000)
  })
})

describe('call-reading tools are Slack-gated', () => {
  it('are NOT in WORKER_TOOLS (so the Hermes/Telegram research worker never gets them)', () => {
    const names = WORKER_TOOLS.map((t) => t.name)
    expect(names).not.toContain('list_calls')
    expect(names).not.toContain('get_call')
    expect(names).not.toContain('search_calls')
  })

  it('executeWorkerTool refuses call tools when they were not offered this call (no availableNames)', async () => {
    for (const name of ['list_calls', 'get_call', 'search_calls']) {
      const res = await executeWorkerTool(name, { id: 'x', query: 'x' })
      expect(res).toContain('not permitted')
    }
  })

  it('executeWorkerTool refuses call tools when availableNames excludes them', async () => {
    const res = await executeWorkerTool('get_call', { id: 'x' }, new Set(['search_crm']))
    expect(res).toContain('not permitted')
  })

  it('exposes correct tool names', () => {
    expect(LIST_CALLS_TOOL.name).toBe('list_calls')
    expect(GET_CALL_TOOL.name).toBe('get_call')
    expect(SEARCH_CALLS_TOOL.name).toBe('search_calls')
  })
})
