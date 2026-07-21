import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'

/**
 * Guards docs/systems/pwa.md rule 4: "No data/page caching in the SW beyond the
 * offline fallback."
 *
 * That rule was prose only, and public/portal-sw.js violated it from 2026-04-02
 * until 2026-07-21 without anything noticing — it cached server-rendered
 * authenticated portal HTML (client ITIN, EIN, address, invoices, and signing
 * URLs that authenticate on their own) and replayed it with no session check
 * whenever a fetch failed. The system-doc freshness gate could not catch it
 * because that gate only fires when a file is EDITED, and this file was never
 * edited. This test fires on every push regardless.
 *
 * If you are here because this test failed: do not add an exception. A service
 * worker must not put pages or API responses into Cache Storage. Precaching a
 * static, session-free offline page is the only permitted use, via the allowlist
 * below.
 */

const PUBLIC_DIR = join(process.cwd(), 'public')

/** Only these URLs may ever be precached by a service worker. */
const PRECACHE_ALLOWLIST = ['/offline']

function serviceWorkerFiles(): string[] {
  return readdirSync(PUBLIC_DIR).filter((name) => name.endsWith('-sw.js'))
}

describe('service workers never cache pages or data', () => {
  it('finds the service worker files it is supposed to guard', () => {
    const files = serviceWorkerFiles()
    // Fails loudly if a worker is renamed or moved, rather than silently passing
    // by guarding nothing.
    expect(files).toContain('portal-sw.js')
    expect(files).toContain('dashboard-sw.js')
  })

  it.each(serviceWorkerFiles())('%s does not call cache.put()', (file) => {
    const source = readFileSync(join(PUBLIC_DIR, file), 'utf8')
    // cache.put is how a response gets written into Cache Storage at runtime —
    // the exact mechanism that poisoned client devices.
    expect(source).not.toMatch(/\.put\s*\(/)
  })

  it.each(serviceWorkerFiles())('%s only precaches allowlisted URLs', (file) => {
    const source = readFileSync(join(PUBLIC_DIR, file), 'utf8')
    const precached: string[] = []

    // cache.add('/x') / cache.addAll([...]) — collect every string literal passed.
    const addCalls = source.matchAll(/\.add(?:All)?\s*\(([\s\S]*?)\)/g)
    for (const call of addCalls) {
      for (const literal of call[1].matchAll(/['"]([^'"]+)['"]/g)) {
        precached.push(literal[1])
      }
    }

    for (const url of precached) {
      expect(
        PRECACHE_ALLOWLIST,
        `${file} precaches ${url}, which is not in the allowlist. A precached URL must be a static, session-free page — never a route that renders client data.`,
      ).toContain(url)
    }
  })

  it.each(serviceWorkerFiles())('%s never precaches a route under /portal', (file) => {
    const source = readFileSync(join(PUBLIC_DIR, file), 'utf8')
    // Belt and braces on top of the allowlist: /portal routes are authenticated
    // and render client financial data, so they can never be a safe precache
    // target even if someone widens the allowlist.
    const addCalls = source.matchAll(/\.add(?:All)?\s*\(([\s\S]*?)\)/g)
    for (const call of addCalls) {
      expect(call[1]).not.toMatch(/['"]\/portal[/'"]/)
    }
  })
})
