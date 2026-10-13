/**
 * The TD Talk TAB in the CRM left menu (dev job c1e326dd): Antonio — "a tab only for TD TALK in the side bar in the crm on top
 * of HOME". Source guards for the wiring that must not drift.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

const read = (p: string) => readFileSync(join(__dirname, '../../', p), 'utf8')

import { countTalkNotifications, countTeamNotifications } from '@/lib/team/workspace'

describe('countTalkNotifications — only what the TD Talk screen shows', () => {
  const rows = [
    { thread_type: 'dm', unread_count: 2, mention_count: 0 },
    { thread_type: 'group', unread_count: 3, mention_count: 1 },
    { thread_type: 'channel', unread_count: 5, mention_count: 2 },
    { thread_type: 'general', unread_count: 40, mention_count: 4 },
    { thread_type: 'discussion', unread_count: 6, mention_count: 0, is_participant: true },
  ]
  it('counts unread DMs and groups, never channels, conversations or @mentions', () => {
    expect(countTalkNotifications(rows as never)).toBe(5)
    expect(countTalkNotifications([{ thread_type: 'general', unread_count: 9, mention_count: 3 }] as never)).toBe(0)
    expect(countTalkNotifications(null)).toBe(0)
    expect(countTalkNotifications([{ thread_type: 'dm', unread_count: null }] as never)).toBe(0)
  })
  it('is never larger than the Team Chat count it is carved out of', () => {
    expect(countTalkNotifications(rows as never)).toBeLessThanOrEqual(countTeamNotifications(rows as never))
  })
})

describe('TD Talk tab wiring', () => {
  const sidebar = read('components/dashboard/sidebar.tsx')
  it('the menu item is FIRST — above Home — for new and returning users', () => {
    const items = sidebar.slice(sidebar.indexOf('const defaultNavigation'))
    expect(items.indexOf("id: 'td-talk'")).toBeGreaterThan(-1)
    expect(items.indexOf("id: 'td-talk'")).toBeLessThan(items.indexOf("id: 'home'"))
    expect(sidebar).toContain("const baseOrder = talkIdx === -1 ? withResearch : ['td-talk', ...withResearch]")
  })
  it('lights its OWN dot (DMs + groups only), listing only those, linking into the tab; held back on neither chat page', () => {
    expect(sidebar).toContain("item.id === 'td-talk' && liveTalk > 0 && pathname !== '/td-talk'")
    expect(sidebar).toContain("only={item.id === 'td-talk' ? 'talk' : undefined}")
    expect(sidebar).toContain("all.filter(i => i.kind === 'dm' || i.kind === 'group')")
    expect(sidebar).toContain("i.url.replace('/team-chat', '/td-talk')")
    expect(sidebar).toContain("pathname === '/team-chat' || pathname === '/td-talk'")
    expect(sidebar).not.toContain("pathnameRef.current !== '/team-chat'")
  })
  it('the page draws the chat at the tab address inside the CRM frame', () => {
    const page = read('app/(dashboard)/td-talk/page.tsx')
    expect(page).toContain('<TalkApp base={TD_TALK_TAB} />')
    expect(page).not.toContain('TalkShell') // the CRM frame already owns sounds, pop-ups and the unread dot
  })
  it('pop-ups, floating windows and auto-pop treat the tab like a chat page', () => {
    expect(read('components/dashboard/realtime-notifications.tsx')).toContain('isTalkSurfacePath(p)')
    expect(read('components/team-chat/floating-chat.tsx')).toContain("pathname === '/td-talk'")
    expect(read('lib/team/chat-autopop.ts')).toContain("['/team-chat', '/td-talk']")
  })
  it('the chat keeps the open conversation in the address it lives at', () => {
    const app = read('components/talk/talk-app.tsx')
    expect(app).toContain('base = TALK_BASE')
    const D = '$' // keeps the literal template text out of a plain string without tripping the lint rule
    expect(app).toContain('`' + D + '{base}?thread=' + D + '{id}`')
    expect(app).not.toContain('`/talk?thread=' + D + '{id}`')
  })
})
