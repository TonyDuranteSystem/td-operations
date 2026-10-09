/**
 * TD Talk's service worker (public/talk-sw.js, dev job c1e326dd) — behaviour, run for real in a sandbox:
 *  - a push always shows a notification, and its tap target stays inside TD Talk;
 *  - a tap only ever moves a TD Talk window (never a CRM window) and opens one when none is open;
 *  - the address rule is the SAME one lib/talk/paths.ts::talkUrlFor implements (the worker is plain JS in public/,
 *    so a test keeps the two in step);
 *  - the CRM worker never takes a TD Talk window on a tap.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import vm from 'vm'
import { talkUrlFor } from '@/lib/talk/paths'

const ORIGIN = 'https://app.example.com'
const root = join(__dirname, '..', '..', 'public')
const talkSource = readFileSync(join(root, 'talk-sw.js'), 'utf8')
const dashboardSource = readFileSync(join(root, 'dashboard-sw.js'), 'utf8')

interface FakeClient {
  url: string
  frameType: string
  focused?: boolean
  navigatedTo?: string
  posted?: Array<{ type: string; url: string }>
  focus: () => Promise<FakeClient>
  navigate?: (u: string) => Promise<FakeClient>
  postMessage: (msg: { type: string; url: string }, ports: unknown[]) => void
}

function makeClient(url: string, frameType = 'top-level', answers = true): FakeClient {
  const c: FakeClient = {
    url, frameType, posted: [],
    focus: async () => { c.focused = true; return c },
    navigate: async (u: string) => { c.navigatedTo = u; return c },
    postMessage: (msg, ports) => {
      c.posted!.push(msg)
      // answer on the port like the page does, when asked to
      const port = ports[0] as { _onmessage?: () => void } | undefined
      if (answers && port && port._onmessage) port._onmessage()
    },
  }
  return c
}

function load(source: string, windowClients: FakeClient[]) {
  const listeners: Record<string, (e: unknown) => void> = {}
  const shown: Array<{ title: string; options: { data: { url: string }; tag: string } }> = []
  const opened: string[] = []
  class FakeChannel {
    port1: { onmessage: (() => void) | null } = { onmessage: null }
    port2: { _onmessage?: () => void } = {}
    constructor() {
      const self = this
      Object.defineProperty(this.port2, '_onmessage', { get: () => self.port1.onmessage ?? undefined })
    }
  }
  const selfObj = {
    location: { origin: ORIGIN },
    addEventListener: (name: string, fn: (e: unknown) => void) => { listeners[name] = fn },
    skipWaiting: () => {},
    clients: { claim: async () => {} },
    registration: { showNotification: async (title: string, options: { data: { url: string }; tag: string }) => { shown.push({ title, options }) } },
  }
  const sandbox: Record<string, unknown> = {
    self: selfObj,
    clients: {
      matchAll: async () => windowClients,
      openWindow: async (u: string) => { opened.push(u) },
    },
    URL, Response, MessageChannel: FakeChannel, setTimeout, clearTimeout, console, Promise,
  }
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox)
  const run = async (name: string, event: Record<string, unknown>) => {
    const waits: Promise<unknown>[] = []
    listeners[name]({ ...event, waitUntil: (p: Promise<unknown>) => waits.push(p) })
    await Promise.all(waits)
  }
  return { listeners, shown, opened, run }
}

const pushEvent = (data: Record<string, unknown>) => ({ data: { json: () => data } })
const clickEvent = (url: unknown) => ({ notification: { close: () => {}, data: { url } } })

describe('talk-sw.js push', () => {
  it('always shows a notification and points its tap at TD Talk', async () => {
    const w = load(talkSource, [])
    await w.run('push', pushEvent({ title: 'DM · Luca', body: 'hi', url: '/team-chat?thread=abc', tag: 'dm-abc' }))
    expect(w.shown).toHaveLength(1)
    expect(w.shown[0].title).toBe('DM · Luca')
    expect(w.shown[0].options.data.url).toBe('/talk?thread=abc')
    expect(w.shown[0].options.tag).toBe('dm-abc')
  })
  it('shows a notification even for a push about something other than Team Chat (iPhone drops silent pushes)', async () => {
    const w = load(talkSource, [])
    await w.run('push', pushEvent({ body: 'x', url: '/portal-chats' }))
    expect(w.shown).toHaveLength(1)
    expect(w.shown[0].title).toBe('TD Talk')
    expect(w.shown[0].options.data.url).toBe('/talk')
  })
  it('does nothing for an empty push', async () => {
    const w = load(talkSource, [])
    await w.run('push', { data: null })
    expect(w.shown).toHaveLength(0)
  })
})

describe('talk-sw.js notification tap', () => {
  it('opens a TD Talk window when none is open', async () => {
    const w = load(talkSource, [makeClient(`${ORIGIN}/accounts`)])
    await w.run('notificationclick', clickEvent('/talk?thread=abc'))
    expect(w.opened).toEqual(['/talk?thread=abc'])
  })
  it('asks an open TD Talk window to go there itself, and focuses it', async () => {
    const talk = makeClient(`${ORIGIN}/talk`)
    const crm = makeClient(`${ORIGIN}/team-chat`)
    const w = load(talkSource, [crm, talk])
    await w.run('notificationclick', clickEvent('/talk?thread=abc'))
    expect(talk.posted).toEqual([{ type: 'td-navigate', url: '/talk?thread=abc' }])
    expect(talk.focused).toBe(true)
    // never touches the CRM window, even one showing the CRM's own Team Chat
    expect(crm.posted).toEqual([])
    expect(crm.focused).toBeUndefined()
    expect(w.opened).toEqual([])
  })
  it('prefers the top-level TD Talk window over a frame', async () => {
    const frame = makeClient(`${ORIGIN}/talk`, 'nested')
    const top = makeClient(`${ORIGIN}/talk`, 'top-level')
    const w = load(talkSource, [frame, top])
    await w.run('notificationclick', clickEvent('/talk'))
    expect(top.posted).toHaveLength(1)
    expect(frame.posted).toEqual([])
  })
  it('falls back to a full navigation when the page never answers', async () => {
    const talk = makeClient(`${ORIGIN}/talk`, 'top-level', false)
    const w = load(talkSource, [talk])
    await w.run('notificationclick', clickEvent('/talk?thread=zzz'))
    expect(talk.navigatedTo).toBe('/talk?thread=zzz')
    expect(talk.focused).toBe(true)
  })
  it('rewrites a CRM Team Chat address stored on an old notification', async () => {
    const w = load(talkSource, [])
    await w.run('notificationclick', clickEvent('/team-chat?thread=old'))
    expect(w.opened).toEqual(['/talk?thread=old'])
  })
})

describe('talk-sw.js address rule is the same as lib/talk/paths.ts', () => {
  const cases: unknown[] = [
    '/team-chat?thread=abc&root=def', '/team-chat', '/team-chat/x?y=1#z', '/talk', '/talk?thread=1', '/talk/x#h',
    '/portal-chats', '/accounts/1', `${ORIGIN}/team-chat?thread=a`, 'https://evil.com/team-chat', '//evil.com/team-chat',
    'javascript:alert(1)', '', null, undefined, 42, '/talking', '/team-chats',
  ]
  it.each(cases.map((c) => [String(c), c]))('%s', async (_label, input) => {
    const w = load(talkSource, [])
    await w.run('push', pushEvent({ url: input }))
    expect(w.shown[0].options.data.url).toBe(talkUrlFor(input, ORIGIN))
  })
})

describe('talk-sw.js housekeeping', () => {
  it('takes over immediately and keeps the update-banner message working', () => {
    expect(talkSource).toContain('self.skipWaiting()')
    expect(talkSource).toContain("event.data.type === 'SKIP_WAITING'")
    expect(talkSource).toContain('self.clients.claim()')
  })
  it('never touches Cache Storage', () => {
    expect(talkSource).not.toMatch(/\bcaches\b/)
  })
  it('only answers page loads', () => {
    expect(talkSource).toContain("if (event.request.mode !== 'navigate') return")
  })
})

describe('dashboard-sw.js leaves TD Talk windows alone', () => {
  it('a CRM notification tap never takes the TD Talk window, but still reuses a CRM one', async () => {
    const talk = makeClient(`${ORIGIN}/talk`)
    const crm = makeClient(`${ORIGIN}/accounts`)
    // the dashboard worker uses plain globals (self.addEventListener etc.) and caches; give it harmless ones
    const w = load(`var caches = { open: function(){ return Promise.resolve({ add: function(){} }) }, keys: function(){ return Promise.resolve([]) }, match: function(){ return Promise.resolve(undefined) }, delete: function(){} };\n${dashboardSource}`, [talk, crm])
    await w.run('notificationclick', clickEvent('/team-chat?thread=abc'))
    expect(talk.posted).toEqual([])
    expect(talk.navigatedTo).toBeUndefined()
    expect(crm.posted).toEqual([{ type: 'td-navigate', url: '/team-chat?thread=abc' }])
  })
  it('opens a new window when the only open window is TD Talk', async () => {
    const talk = makeClient(`${ORIGIN}/talk/`)
    const w = load(`var caches = { open: function(){ return Promise.resolve({ add: function(){} }) }, keys: function(){ return Promise.resolve([]) }, match: function(){ return Promise.resolve(undefined) }, delete: function(){} };\n${dashboardSource}`, [talk])
    await w.run('notificationclick', clickEvent('/team-chat?thread=abc'))
    expect(talk.posted).toEqual([])
    expect(w.opened).toEqual(['/team-chat?thread=abc'])
  })
})
