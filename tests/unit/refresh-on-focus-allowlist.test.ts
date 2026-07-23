import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  REFRESH_ON_FOCUS_QUERY_KEYS,
  REFRESH_ON_FOCUS_EXCLUDED_FOR_COST,
} from '@/lib/query/refresh-on-focus'

/**
 * These tests exist because the FIRST attempt at this feature shipped an
 * exclude-list, and the sweep behind it missed four of the five Gmail-backed
 * screens. An allow-list is safer, but only while it stays honest — so this
 * asserts the two properties that make it safe, against the real files.
 */
describe('refresh-on-focus allow-list', () => {
  it('never contains a key that is also recorded as too expensive', () => {
    const overlap = REFRESH_ON_FOCUS_QUERY_KEYS.filter(k =>
      REFRESH_ON_FOCUS_EXCLUDED_FOR_COST.includes(k))
    expect(overlap, `these keys are in BOTH lists: ${overlap.join(', ')}`).toEqual([])
  })

  it('has no duplicates (a duplicate hides a copy-paste mistake)', () => {
    const dupes = REFRESH_ON_FOCUS_QUERY_KEYS.filter((k, i) =>
      REFRESH_ON_FOCUS_QUERY_KEYS.indexOf(k) !== i)
    expect(dupes).toEqual([])
  })

  it('is not empty — an empty list silently disables the whole feature', () => {
    expect(REFRESH_ON_FOCUS_QUERY_KEYS.length).toBeGreaterThan(0)
  })

  // The load-bearing one. If someone adds a query key here whose route calls
  // Gmail or Drive, this fails — which is precisely the mistake that caused the
  // first attempt to be pulled from the ship.
  it('no allowed key maps to a route whose GET calls Gmail or Drive', () => {
    const roots = ['app', 'components']
    const walk = (dir: string, out: string[] = []): string[] => {
      if (!existsSync(dir)) return out
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name)
        if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p, out) }
        else if (/\.(ts|tsx)$/.test(e.name)) out.push(p)
      }
      return out
    }
    const sources = roots.flatMap(r => walk(r))

    // key -> the endpoint(s) its useQuery fetches
    const endpointsFor = new Map<string, Set<string>>()
    for (const f of sources) {
      const s = readFileSync(f, 'utf8')
      for (const m of s.matchAll(/useQuery\s*[<(]/g)) {
        const win = s.slice(m.index ?? 0, (m.index ?? 0) + 1400)
        const key = win.match(/queryKey:\s*\[\s*'([^']+)'/)?.[1]
        const url = win.match(/fetch\(\s*[`'"]([^`'"$?]+)/)?.[1]
        if (!key || !url) continue
        if (!REFRESH_ON_FOCUS_QUERY_KEYS.includes(key)) continue
        if (!endpointsFor.has(key)) endpointsFor.set(key, new Set())
        endpointsFor.get(key)!.add(url)
      }
    }

    const offenders: string[] = []
    for (const [key, urls] of endpointsFor) {
      for (const url of urls) {
        const route = url.replace(/^\//, '').split('?')[0].replace(/\/$/, '')
        // resolve /api/a/b -> app/api/a/b/route.ts, allowing one dynamic segment
        let file: string | null = null
        const direct = join('app', route, 'route.ts')
        if (existsSync(direct)) file = direct
        else {
          const parts = route.split('/')
          for (let i = parts.length; i > 1 && !file; i--) {
            const dir = join('app', ...parts.slice(0, i))
            if (!existsSync(dir)) continue
            for (const sub of readdirSync(dir)) {
              if (sub.startsWith('[') && existsSync(join(dir, sub, 'route.ts'))) {
                file = join(dir, sub, 'route.ts'); break
              }
            }
          }
        }
        if (!file) continue
        const body = readFileSync(file, 'utf8')
        // Only the GET handler matters — several routes call Gmail in POST
        // (sending a message) while their GET is pure DB. A file-level grep
        // gets this wrong; /api/portal/chat is exactly that case.
        const getStart = body.search(/export async function GET/)
        if (getStart === -1) continue
        const after = body.slice(getStart + 1)
        const nextFn = after.search(/export async function (POST|PATCH|PUT|DELETE)/)
        const getBody = nextFn === -1 ? after : after.slice(0, nextFn)
        if (/gmailGet|gmailPost|gmailList|driveGet|listFolder|drive\.files/.test(getBody)) {
          offenders.push(`${key} -> ${url} (${file})`)
        }
      }
    }

    expect(
      offenders,
      `These allow-listed queries hit Gmail/Drive on GET and would fire on every ` +
      `tab-back:\n  ${offenders.join('\n  ')}\n` +
      `Gmail quota starvation has already blanked the inbox once — remove them.`,
    ).toEqual([])
  })
})
