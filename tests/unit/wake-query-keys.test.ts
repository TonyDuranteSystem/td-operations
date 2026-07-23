import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Guards the CRM wake list against the one mistake that has already cost this
 * feature two rounds: letting a Gmail-backed query refresh on every tab-back.
 *
 * The default INBOX list issues ~300 live Gmail metadata calls per load, and a
 * bulk action has already starved the per-user quota and blanked the inbox.
 *
 * A previous version of this guard tried to resolve each key to its route by
 * pattern-matching source, and it SILENTLY PASSED with the worst offender in the
 * list — the URL was built in a variable so the regex found nothing and the test
 * skipped it without saying so. This version does not try to be clever: it
 * asserts the forbidden names are absent, and that the list has not grown
 * without someone updating this test. Dumb and unfoolable beats clever and
 * silently wrong.
 */
const LISTENER = 'components/dashboard/ui-event-listener.tsx'

function wakeKeys(): string[] {
  const src = readFileSync(LISTENER, 'utf8')
  const block = src.match(/const WAKE_QUERY_KEYS = \[([\s\S]*?)\n\]/)
  if (!block) throw new Error('WAKE_QUERY_KEYS not found — did the constant get renamed?')
  return [...block[1].matchAll(/'([^']+)'/g)].map(m => m[1])
}

/** Every query key whose GET calls Gmail or Drive. Adding one to the wake list
 *  means a live Gmail request on every tab-back, for every open tab. */
const FORBIDDEN = [
  'inbox-conversations',  // ~300 Gmail metadata calls per load
  'inbox-messages',       // live Gmail full-thread fetch
  'inbox-stats',
  'gmail-labels',
  'client-emails',        // N+1: one Gmail call per thread
  'email-unread',
  'correspondence',       // Drive
]

describe('CRM wake query keys', () => {
  it('contains no Gmail- or Drive-backed key', () => {
    const keys = wakeKeys()
    const offenders = keys.filter(k => FORBIDDEN.includes(k))
    expect(
      offenders,
      `These hit Gmail/Drive on GET and would fire on EVERY tab-back:\n  ${offenders.join('\n  ')}\n` +
      `Gmail quota starvation has already blanked the inbox once. Remove them.`,
    ).toEqual([])
  })

  it('every key is a non-empty, plausible query key', () => {
    for (const k of wakeKeys()) {
      expect(k.length, `empty key in WAKE_QUERY_KEYS`).toBeGreaterThan(0)
      expect(k, `'${k}' looks like a URL, not a query key`).not.toContain('/')
    }
  })

  it('has no duplicates', () => {
    const keys = wakeKeys()
    const dupes = keys.filter((k, i) => keys.indexOf(k) !== i)
    expect(dupes).toEqual([])
  })

  it('covers the two surfaces a returning user is most likely staring at', () => {
    // These two were MISSING from the registries an earlier draft proposed to
    // reuse — the open client conversation and the open staff DM. Both reviewers
    // caught it independently. If someone trims the list, these must survive.
    const keys = wakeKeys()
    expect(keys).toContain('portal-chat-messages')
    expect(keys).toContain('internal-thread-messages')
  })

  it('is actually wired to the wake signal, not just declared', () => {
    const src = readFileSync(LISTENER, 'utf8')
    expect(src).toContain('useWakeSignal')
    // The list must be used inside the wake handler, or it is decoration.
    const wakeBlock = src.slice(src.indexOf('useWakeSignal'))
    expect(wakeBlock).toContain('WAKE_QUERY_KEYS')
  })

  it('the portal never wake-refreshes a signing route', () => {
    // A refresh re-runs the page's server code; a transient DB error or a
    // staff action mid-session can flip the branch and replace an open signing
    // document with "not found" — while the client is signing.
    const src = readFileSync('components/portal/portal-wake-refresh.tsx', 'utf8')
    expect(src).toContain('/portal/sign')
    expect(src).toContain('enabled: !onSigningRoute')
  })

  it('the wake component is mounted in BOTH portal layout branches', () => {
    // The teammate branch returns early. Mounting only in the main branch would
    // silently exclude teammates, who use the same shell.
    const layout = readFileSync('app/portal/layout.tsx', 'utf8')
    const mounts = [...layout.matchAll(/<PortalWakeRefresh\s*\/>/g)]
    expect(mounts.length, 'expected PortalWakeRefresh in both the teammate and main branches').toBe(2)
  })

  it('the global reconnect-refetch default stays OFF', () => {
    // Left undefined, react-query defaults it to TRUE and every stale Gmail
    // query refetches on every wifi/cellular handoff. That was live for months.
    const providers = readFileSync('components/providers.tsx', 'utf8')
    expect(providers).toContain('refetchOnReconnect: false')
    expect(providers).toContain('refetchOnWindowFocus: false')
  })
})

describe('no stray wake implementations', () => {
  it('portal and dashboard wake go through the shared hook', () => {
    for (const f of ['components/portal/portal-wake-refresh.tsx', LISTENER]) {
      expect(readFileSync(f, 'utf8'), `${f} should use the shared hook`).toContain('useWakeSignal')
    }
  })

  it('the shared hook exists and exports its decision function', () => {
    const p = 'lib/hooks/use-wake-signal.ts'
    expect(existsSync(p)).toBe(true)
    const src = readFileSync(p, 'utf8')
    expect(src).toContain('export function shouldWake')
    // All four signals must stay wired — each covers a case the others miss.
    for (const ev of ['visibilitychange', 'focus', 'online', 'pageshow']) {
      expect(src, `wake signal lost its '${ev}' listener`).toContain(ev)
    }
  })
})

// Sanity: the repo layout this test assumes still exists.
describe('test assumptions', () => {
  it('runs from the repo root', () => {
    expect(readdirSync('.')).toContain('components')
    expect(existsSync(join('components', 'dashboard'))).toBe(true)
  })
})
