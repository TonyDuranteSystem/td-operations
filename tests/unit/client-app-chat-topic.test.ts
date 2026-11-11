import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseTimestamp } from '@/lib/portal/chat-refresh-merge'
import { chooseOpeningTopic, isUnreadAnswer, newestUnreadTopic, unreadInOtherTopics, type TopicMessage } from '@/lib/portal-app/chat-topic'
import { TITLE_IN_ROW, screenTitleFor } from '@/lib/portal-app/frame'

// Client iPhone app, Step 3b (dev job 056a70d0): the Topic button's rules and the app's opening rule.

const at = (min: number) => new Date(Date.UTC(2026, 10, 8, 9, min)).toISOString()
const answer = (topic: string | null, min: number, extra: Partial<TopicMessage> = {}): TopicMessage =>
  ({ topic, sender_type: 'admin', read_at: null, created_at: at(min), ...extra })

describe('isUnreadAnswer', () => {
  it('is a team message not read yet, or one the client marked unread again', () => {
    expect(isUnreadAnswer(answer('Tax', 1))).toBe(true)
    expect(isUnreadAnswer(answer('Tax', 1, { read_at: at(2) }))).toBe(false)
    expect(isUnreadAnswer(answer('Tax', 1, { read_at: at(2), client_kept_unread: true }))).toBe(true)
  })

  it('is never the client\'s own message, and never a deleted one (R100)', () => {
    expect(isUnreadAnswer({ topic: 'Tax', sender_type: 'client', read_at: null, created_at: at(1) })).toBe(false)
    expect(isUnreadAnswer(answer('Tax', 1, { deleted_at: at(3) }))).toBe(false)
  })
})

describe('newestUnreadTopic', () => {
  it('names the topic of the newest unread answer, wherever it was sent', () => {
    const msgs = [answer('Bank account', 5), answer('Tax return', 9), answer(null, 2)]
    expect(newestUnreadTopic(msgs)).toBe('Tax return')
  })

  it('is General (empty name) when the newest unread answer is untagged', () => {
    expect(newestUnreadTopic([answer('Tax return', 3), answer(null, 8)])).toBe('')
    expect(newestUnreadTopic([answer('Tax return', 3), answer(undefined, 8)])).toBe('')
  })

  it('ignores read, own and deleted messages, and is null when nothing unread is loaded', () => {
    expect(newestUnreadTopic([])).toBeNull()
    expect(newestUnreadTopic([answer('Tax', 9, { read_at: at(10) }), answer('Bank', 4)])).toBe('Bank')
    expect(newestUnreadTopic([answer('Tax', 9, { read_at: at(10) })])).toBeNull()
    expect(newestUnreadTopic([answer('Tax', 9, { deleted_at: at(10) })])).toBeNull()
  })

  it('does not depend on the order the list arrives in', () => {
    const a = [answer('One', 1), answer('Two', 7), answer('Three', 4)]
    expect(newestUnreadTopic(a)).toBe('Two')
    expect(newestUnreadTopic([...a].reverse())).toBe('Two')
  })
})

describe('chooseOpeningTopic — the app\'s rule', () => {
  it('opens on the topic of the newest unread answer, even when General also has unread', () => {
    const messages = [answer(null, 2), answer('Tax return', 9)]
    expect(chooseOpeningTopic({ serverUnread: { '': 1, 'Tax return': 1 }, messages, newestAnswerRule: true })).toBe('Tax return')
  })

  it('stays on General when the newest unread answer is in General', () => {
    const messages = [answer('Tax return', 2), answer(null, 9)]
    expect(chooseOpeningTopic({ serverUnread: { '': 1, 'Tax return': 5 }, messages, newestAnswerRule: true })).toBeNull()
  })

  it('falls back to the server counts when no unread answer is among the loaded messages', () => {
    expect(chooseOpeningTopic({ serverUnread: { Old: 3, Other: 1 }, messages: [], newestAnswerRule: true })).toBe('Old')
    expect(chooseOpeningTopic({ serverUnread: {}, messages: [], newestAnswerRule: true })).toBeNull()
  })
})

// The website must open exactly as before: the old rule is frozen here (copied from components/portal/portal-chat.tsx before Step 3b)
// and compared with the new function over a grid of situations.
function oldWebsiteRule(serverUnread: Record<string, number>, messages: TopicMessage[]): string | null {
  if ((serverUnread[''] ?? 0) > 0) return null
  const candidates = Object.entries(serverUnread).filter(([k, n]) => k && n > 0)
  if (candidates.length === 0) return null
  const lastAt = (k: string) => Math.max(0, ...messages.filter(m => (m.topic ?? '') === k).map(m => parseTimestamp(m.created_at)))
  candidates.sort((a, b) => (b[1] - a[1]) || (lastAt(b[0]) - lastAt(a[0])))
  return candidates[0][0]
}

describe('chooseOpeningTopic — the website\'s rule is unchanged', () => {
  const topicsPool = ['', 'Tax', 'Bank', 'Formation']
  const counts = [0, 1, 2, 5]
  it('gives the old answer for every combination of counts and loaded messages', () => {
    let checked = 0
    for (const g of counts) for (const t of counts) for (const b of counts) for (const f of counts) {
      const serverUnread: Record<string, number> = { '': g, Tax: t, Bank: b, Formation: f }
      for (const layout of [0, 1, 2, 3]) {
        const messages: TopicMessage[] = topicsPool.map((tp, i) => ({
          topic: tp || null,
          sender_type: i % 2 ? 'admin' : 'client',
          read_at: null,
          created_at: at(layout === 0 ? i : layout === 1 ? 10 - i : layout === 2 ? 5 : 20 + ((i * 7) % 4)),
        }))
        expect(chooseOpeningTopic({ serverUnread, messages, newestAnswerRule: false })).toBe(oldWebsiteRule(serverUnread, messages))
        checked++
      }
    }
    expect(checked).toBe(4 * 4 * 4 * 4 * 4)
  })
})

describe('unreadInOtherTopics', () => {
  it('adds the unread answers of every topic except the open one', () => {
    expect(unreadInOtherTopics({ '': 2, Tax: 1, Bank: 3 }, 'Tax')).toBe(5)
    expect(unreadInOtherTopics({ '': 2, Tax: 1, Bank: 3 }, null)).toBe(4)
  })

  it('is 0 when nothing is unread elsewhere', () => {
    expect(unreadInOtherTopics({}, null)).toBe(0)
    expect(unreadInOtherTopics({ Tax: 2 }, 'Tax')).toBe(0)
    expect(unreadInOtherTopics({ Tax: 0, Bank: 0 }, null)).toBe(0)
  })
})

describe('Chat in the app frame', () => {
  const items = [{ key: 'nav.chat', path: '/portal/chat', label: 'Chat' }, { key: 'nav.overview', path: '/portal', label: 'Overview' }]

  it('puts the screen\'s name in the top row', () => {
    expect(TITLE_IN_ROW).toContain('/portal/chat')
    expect(screenTitleFor('/portal/chat', items)).toBe('Chat')
    expect(screenTitleFor('/portal/chat/open', items)).toBe('Chat')
  })
})

describe('wiring (source guards)', () => {
  const chat = readFileSync(join(process.cwd(), 'components/portal/portal-chat.tsx'), 'utf8')
  const page = readFileSync(join(process.cwd(), 'app/portal/chat/page.tsx'), 'utf8')

  it('the website\'s pill row stays and is only hidden in the app; the Topic button draws only in the app', () => {
    expect(chat).toContain('<div className="app-hide px-3 pt-2 pb-1 border-b border-zinc-100 flex items-center gap-1.5 overflow-x-auto">')
    expect(chat).toMatch(/\{appMode && \(\s*<div[^>]*data-testid="app-chat-header"/)
    expect(chat).toContain('chooseOpeningTopic({ serverUnread, messages, newestAnswerRule: appMode })')
  })

  it('the page drops its heading, the team line and the Journey Log tab only in the app', () => {
    expect(page).toContain('getClientAppModeActive()')
    expect(page).toContain("view === 'log' && !isTeammate && !appMode")
    expect(page).toContain('{!appMode && (')
    expect(page).toContain('{!isTeammate && !appMode && (')
  })
})
