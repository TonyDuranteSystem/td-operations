import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
  databaseLoginLimiter, layeredLoginLimiter, memoryLoginLimiter, type LoginLimiter, type RpcCall,
} from '@/lib/portal/login-limiter'
import { teamLoginAttempt, type TeamLoginDeps } from '@/lib/portal/team/login-flow'
import { LOGIN_MAX_FAILURES } from '@/lib/portal/rate-limit'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
let n = 0
const k = (label: string) => `${label}:${++n}:${Math.round(performance.now())}`
const locked = (r: { ok: boolean; error?: string }) => !r.ok && /Too many failed attempts/.test(r.error ?? '')

/** A stand-in for the database function: the SAME rules as portal_login_reserve / release / clear, one key at a time (the real function
 *  locks the row; its atomicity is proven against the real database in the sandbox, not here). Shared by every "server" in a test. */
function fakeSharedDatabase(opts: { failWith?: () => string | null } = {}) {
  const rows = new Map<string, { failures: number; lockedUntil: number }>()
  const calls = { reserve: 0, release: 0, clear: 0 }
  const rpc: RpcCall = async (fn, args) => {
    const failure = opts.failWith?.()
    if (failure) return { data: null, error: { message: failure } }
    const key = String(args.p_key)
    if (fn === 'portal_login_reserve') {
      calls.reserve++
      await sleep(1)
      const row = rows.get(key) ?? { failures: 0, lockedUntil: 0 }
      if (row.lockedUntil > Date.now()) return { data: [{ allowed: false, retry_after_seconds: 899 }], error: null }
      row.failures += 1
      if (row.failures >= Number(args.p_max)) row.lockedUntil = Date.now() + Number(args.p_window_seconds ?? 900) * 1000
      rows.set(key, row)
      return { data: [{ allowed: true, retry_after_seconds: 0 }], error: null }
    }
    if (fn === 'portal_login_release') {
      calls.release++
      const row = rows.get(key)
      if (row && !row.lockedUntil) { row.failures = Math.max(0, row.failures - 1); if (row.failures === 0) rows.delete(key) }
      return { data: null, error: null }
    }
    if (fn === 'portal_login_clear') { calls.clear++; rows.delete(key); return { data: null, error: null } }
    return { data: null, error: { message: `unknown function ${fn}` } }
  }
  return { rpc, rows, calls }
}

describe('memoryLoginLimiter — the per-server counter behind the three steps', () => {
  it('admits up to the limit, then refuses without counting', async () => {
    const l = memoryLoginLimiter(); const key = k('mem')
    for (let i = 0; i < 3; i++) expect((await l.reserve(key, 3)).allowed).toBe(true)
    const refused = await l.reserve(key, 3)
    expect(refused.allowed).toBe(false)
    expect(refused.retryAfter).toBeGreaterThan(0)
  })
  it('a burst of simultaneous reserves is admitted exactly up to the limit', async () => {
    const l = memoryLoginLimiter(); const key = k('burst')
    const res = await Promise.all(Array.from({ length: 30 }, () => l.reserve(key, 5)))
    expect(res.filter((r) => r.allowed).length).toBe(5)
  })
  it('release gives one back, clear forgets the key', async () => {
    const l = memoryLoginLimiter(); const key = k('rel')
    await l.reserve(key, 2); await l.release(key)
    expect((await l.reserve(key, 2)).allowed).toBe(true)
    expect((await l.reserve(key, 2)).allowed).toBe(true)
    expect((await l.reserve(key, 2)).allowed).toBe(false)
    await l.clear(key)
    expect((await l.reserve(key, 2)).allowed).toBe(true)
  })
})

describe('databaseLoginLimiter — the shared counter', () => {
  it('sends the key, the cap and the window to the database function and maps the answer', async () => {
    const seen: Array<{ fn: string; args: Record<string, unknown> }> = []
    const rpc: RpcCall = async (fn, args) => { seen.push({ fn, args }); return { data: [{ allowed: false, retry_after_seconds: 641 }], error: null } }
    const r = await databaseLoginLimiter(rpc, 900).reserve('teammate-login:1.2.3.4:marco.rossi', 5)
    expect(r).toEqual({ allowed: false, retryAfter: 641 })
    expect(seen[0]).toEqual({ fn: 'portal_login_reserve', args: { p_key: 'teammate-login:1.2.3.4:marco.rossi', p_max: 5, p_window_seconds: 900 } })
  })
  it('an admitted attempt carries no retry time', async () => {
    const rpc: RpcCall = async () => ({ data: [{ allowed: true, retry_after_seconds: 0 }], error: null })
    expect(await databaseLoginLimiter(rpc).reserve('x', 5)).toEqual({ allowed: true })
  })
  it('release and clear call their functions', async () => {
    const seen: string[] = []
    const rpc: RpcCall = async (fn) => { seen.push(fn); return { data: null, error: null } }
    const l = databaseLoginLimiter(rpc)
    await l.release('x'); await l.clear('x')
    expect(seen).toEqual(['portal_login_release', 'portal_login_clear'])
  })
  it.each([
    ['a database error', { data: null, error: { message: 'relation "portal_login_attempts" does not exist' } }],
    ['no rows', { data: [], error: null }],
    ['a malformed row', { data: [{ allowed: 'yes' }], error: null }],
    ['nothing at all', { data: null, error: null }],
  ])('throws on %s (so the caller can fall back)', async (_name, answer) => {
    const rpc: RpcCall = async () => answer as never
    await expect(databaseLoginLimiter(rpc).reserve('x', 5)).rejects.toThrow()
  })
})

describe('layeredLoginLimiter — the shared counter first, the per-server counter when it fails', () => {
  const failing: LoginLimiter = { reserve: async () => { throw new Error('boom') }, release: async () => { throw new Error('boom') }, clear: async () => { throw new Error('boom') } }

  it('uses the shared counter while it works', async () => {
    const db = fakeSharedDatabase()
    const l = layeredLoginLimiter(databaseLoginLimiter(db.rpc), memoryLoginLimiter(), { log: () => undefined })
    const key = k('layer-ok')
    for (let i = 0; i < LOGIN_MAX_FAILURES; i++) await l.reserve(key, LOGIN_MAX_FAILURES)
    expect(db.calls.reserve).toBe(LOGIN_MAX_FAILURES)
    expect((await l.reserve(key, LOGIN_MAX_FAILURES)).allowed).toBe(false)
  })

  it('falls back to the per-server counter when the shared one fails — a sign-in is never blocked by the fault, and the cap still holds per server', async () => {
    const logs: string[] = []
    const l = layeredLoginLimiter(failing, memoryLoginLimiter(), { log: (m) => logs.push(m) })
    const key = k('layer-fb')
    const res = await Promise.all(Array.from({ length: 12 }, () => l.reserve(key, 5)))
    expect(res.filter((r) => r.allowed).length).toBe(5)
    expect(logs.length).toBe(1)
    expect(logs[0]).toMatch(/shared counter unavailable/)
  })

  it('leaves a failing shared counter alone for the pause, then tries it again', async () => {
    let t = 1_000_000
    let primaryCalls = 0
    const flaky: LoginLimiter = { reserve: async () => { primaryCalls++; throw new Error('down') }, release: async () => undefined, clear: async () => undefined }
    const l = layeredLoginLimiter(flaky, memoryLoginLimiter(), { now: () => t, pauseMs: 30_000, log: () => undefined })
    await l.reserve(k('p1'), 5); expect(primaryCalls).toBe(1)
    t += 10_000; await l.reserve(k('p2'), 5); expect(primaryCalls).toBe(1) // paused: not called
    t += 25_000; await l.reserve(k('p3'), 5); expect(primaryCalls).toBe(2) // pause over: tried again
  })

  it('logs a fault at most once a minute', async () => {
    let t = 5_000_000
    const logs: string[] = []
    const l = layeredLoginLimiter(failing, memoryLoginLimiter(), { now: () => t, pauseMs: 1_000, log: (m) => logs.push(m) })
    for (let i = 0; i < 5; i++) { await l.reserve(k('log'), 5); t += 5_000 } // 5 faults in 25 s
    expect(logs.length).toBe(1)
    t += 60_000; await l.reserve(k('log'), 5)
    expect(logs.length).toBe(2)
  })
})

describe('the sign-in across SEVERAL servers sharing the counter', () => {
  function server(db: ReturnType<typeof fakeSharedDatabase>, calls: { signIn: number }): TeamLoginDeps {
    return {
      // each server has its OWN memory limiter as fallback and its own layered limiter — only the database is shared
      limiter: layeredLoginLimiter(databaseLoginLimiter(db.rpc), memoryLoginLimiter(), { log: () => undefined }),
      resolve: async (name) => (name === 'marco.rossi' ? { teamMemberId: `member-${n}`, email: 'hidden@example.test' } : null),
      signIn: async (_e, pw) => { calls.signIn++; await sleep(2); return pw === 'correct-horse' },
    }
  }

  it('a burst spread over 4 servers is capped in TOTAL (the live-site gap this closes)', async () => {
    const db = fakeSharedDatabase(); const calls = { signIn: 0 }
    n += 1
    const servers = [0, 1, 2, 3].map(() => server(db, calls))
    const ip = `10.7.${n}.1`
    const results = await Promise.all(Array.from({ length: 40 }, (_, i) => teamLoginAttempt(servers[i % 4], { ip, username: 'marco.rossi', password: `g${i}` })))
    expect(calls.signIn).toBe(LOGIN_MAX_FAILURES) // 5 password checks in total, not 5 per server
    expect(results.filter(locked).length).toBe(40 - LOGIN_MAX_FAILURES)
  })

  it('a database outage falls back per server: sign-in still works and still counts', async () => {
    const db = fakeSharedDatabase({ failWith: () => 'connection refused' }); const calls = { signIn: 0 }
    n += 1
    const s = server(db, calls); const ip = `10.9.${n}.1`
    expect((await teamLoginAttempt(s, { ip, username: 'marco.rossi', password: 'correct-horse' })).ok).toBe(true)
    for (let i = 0; i < LOGIN_MAX_FAILURES; i++) await teamLoginAttempt(s, { ip, username: 'marco.rossi', password: `w${i}` })
    expect(locked(await teamLoginAttempt(s, { ip, username: 'marco.rossi', password: 'w-last' }))).toBe(true)
  })

  it('a success refunds the shared address and login counters and clears the address+username one', async () => {
    const db = fakeSharedDatabase(); const calls = { signIn: 0 }; n += 1
    const s = server(db, calls); const ip = `10.6.${n}.1`
    expect((await teamLoginAttempt(s, { ip, username: 'marco.rossi', password: 'correct-horse' })).ok).toBe(true)
    expect(db.calls.clear).toBe(1)
    expect(db.calls.release).toBe(2) // the address and the login
    expect(Array.from(db.rows.keys()).filter((key) => key.includes(ip) || key.startsWith('teammate-login-acct:')).length).toBe(0)
  })
})

describe('the wiring', () => {
  const read = (p: string) => readFileSync(path.join(process.cwd(), p), 'utf8')
  it('the real limiter is the shared counter with the per-server counter as fallback', () => {
    const src = read('lib/portal/login-limiter-default.ts')
    expect(src).toMatch(/layeredLoginLimiter\(/)
    expect(src).toMatch(/databaseLoginLimiter\(/)
    expect(src).toMatch(/memoryLoginLimiter\(\)/)
  })
  it('the migration has the table, three functions, no public access and the standing lock', () => {
    const sql = read('scripts/migrations/20261121-0300-portal-login-attempts.sql')
    for (const needle of ['CREATE TABLE IF NOT EXISTS public.portal_login_attempts', 'FUNCTION public.portal_login_reserve', 'FUNCTION public.portal_login_release', 'FUNCTION public.portal_login_clear',
      'FOR UPDATE', 'ENABLE ROW LEVEL SECURITY', 'FROM anon, authenticated', 'marketing_lock_all_tables']) expect(sql, needle).toContain(needle)
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.portal_login_reserve\(text, integer, integer\) FROM PUBLIC, anon, authenticated/)
    expect(read('scripts/migrations/20261121-0300-portal-login-attempts.UNDO.sql')).toMatch(/DROP TABLE IF EXISTS public\.portal_login_attempts/)
  })
})
