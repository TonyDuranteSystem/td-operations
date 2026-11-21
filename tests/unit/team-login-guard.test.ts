import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
  ACCOUNT_MAX_FAILURES, IP_MAX_FAILURES, INVALID_LOGIN_MESSAGE, canonicalTeamUsername, teamLoginKeys,
} from '@/lib/portal/team/login-guard'
import { teamLoginAttempt, type TeamLoginDeps } from '@/lib/portal/team/login-flow'
import { memoryLoginLimiter } from '@/lib/portal/login-limiter'
import {
  LOGIN_MAX_FAILURES, checkLoginRateLimit, recordLoginFailure, releaseLoginAttempt,
} from '@/lib/portal/rate-limit'

const read = (p: string) => readFileSync(path.join(process.cwd(), p), 'utf8')
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

let n = 0
// The REAL lockout code, with a fake database: counts how often the lookup and the password check are reached.
function harness(opts: { password?: string; users?: Record<string, { id: string; email: string }> } = {}) {
  // every test gets its OWN login id: the per-login counter lives in module memory and would otherwise carry over between tests
  const users = opts.users ?? { 'marco.rossi': { id: `member-${++n}`, email: 'hidden@example.test' } }
  const right = opts.password ?? 'correct-horse'
  const calls = { resolve: 0, signIn: 0 }
  const deps: TeamLoginDeps = {
    limiter: memoryLoginLimiter(),
    resolve: async (name) => { calls.resolve++; await sleep(3); const u = users[name]; return u ? { teamMemberId: u.id, email: u.email } : null },
    signIn: async (_email, pw) => { calls.signIn++; await sleep(3); return pw === right },
  }
  return { deps, calls, right }
}
const freshIp = () => `10.99.${Math.floor(++n / 250)}.${n % 250}`
const locked = (r: { ok: boolean; error?: string }) => !r.ok && /Too many failed attempts/.test(r.error ?? '')

describe('canonicalTeamUsername — one exact spelling', () => {
  it('accepts a normal username, trimmed and lower-cased', () => {
    expect(canonicalTeamUsername('marco.rossi')).toBe('marco.rossi')
    expect(canonicalTeamUsername('  Marco.Rossi  ')).toBe('marco.rossi')
    expect(canonicalTeamUsername('a-b_c.d9')).toBe('a-b_c.d9')
  })
  it.each(['marco.rossi*', '*arco.rossi', 'm*rco.rossi', 'marco.rossi**', 'marco%', 'ma co', 'marco@x.com', 'ab', 'x'.repeat(31), '', '   ', 'março.rossi', 'marco.rossi\n*'])(
    'refuses %j',
    (bad) => { expect(canonicalTeamUsername(bad)).toBeNull() },
  )
  it('refuses a value that is not text', () => {
    for (const v of [null, undefined, 42, {}, ['marco.rossi']]) expect(canonicalTeamUsername(v)).toBeNull()
  })
})

describe('teamLoginAttempt — the guessing protection, against the real lockout code', () => {
  it('a star in the username never reaches the database, and every odd spelling shares ONE counter', async () => {
    const ip = freshIp()
    const { deps, calls } = harness()
    const variants = ['marco.rossi*', '*arco.rossi', 'm*rco.rossi', 'marco.rossi**', 'marco.rossi%']
    const answers = []
    for (const v of variants) answers.push(await teamLoginAttempt(deps, { ip, username: v, password: 'guess' }))
    expect(calls.resolve).toBe(0)
    expect(calls.signIn).toBe(0)
    expect(answers.map((a) => a.error)).toEqual(Array(5).fill(INVALID_LOGIN_MESSAGE))
    // the sixth odd spelling from the same address is refused as locked — it did NOT get fresh tries
    expect(locked(await teamLoginAttempt(deps, { ip, username: 'marco.rossi*x', password: 'guess' }))).toBe(true)
  })

  it('locks after the cap: the next password is not even checked', async () => {
    const ip = freshIp()
    const { deps, calls } = harness()
    for (let i = 0; i < LOGIN_MAX_FAILURES; i++) {
      expect((await teamLoginAttempt(deps, { ip, username: 'marco.rossi', password: `wrong${i}` })).error).toBe(INVALID_LOGIN_MESSAGE)
    }
    expect(calls.signIn).toBe(LOGIN_MAX_FAILURES)
    const next = await teamLoginAttempt(deps, { ip, username: 'marco.rossi', password: 'correct-horse' })
    expect(locked(next)).toBe(true)
    expect(calls.signIn).toBe(LOGIN_MAX_FAILURES) // not asked again — even the RIGHT password is refused while locked
  })

  it('a burst of parallel guesses cannot all slip through (attempts are counted before the slow steps)', async () => {
    const ip = freshIp()
    const { deps, calls } = harness()
    const results = await Promise.all(Array.from({ length: 25 }, (_, i) => teamLoginAttempt(deps, { ip, username: 'marco.rossi', password: `g${i}` })))
    expect(calls.signIn).toBeLessThanOrEqual(LOGIN_MAX_FAILURES)
    expect(results.filter(locked).length).toBeGreaterThanOrEqual(25 - LOGIN_MAX_FAILURES)
  })

  it('a burst of parallel guesses with different odd spellings of the same username is capped too', async () => {
    const ip = freshIp()
    const { deps, calls } = harness()
    const spell = (i: number) => (['marco.rossi', 'MARCO.ROSSI', ' marco.rossi ', 'Marco.Rossi'][i % 4])
    await Promise.all(Array.from({ length: 30 }, (_, i) => teamLoginAttempt(deps, { ip, username: spell(i), password: `g${i}` })))
    expect(calls.signIn).toBeLessThanOrEqual(LOGIN_MAX_FAILURES)
  })

  it('many addresses against ONE login are capped together (the per-login total)', async () => {
    const { deps, calls } = harness()
    const results = []
    for (let i = 0; i < 60; i++) results.push(await teamLoginAttempt(deps, { ip: freshIp(), username: 'marco.rossi', password: `g${i}` }))
    expect(calls.signIn).toBe(ACCOUNT_MAX_FAILURES)
    expect(results.slice(ACCOUNT_MAX_FAILURES).every(locked)).toBe(true)
  })

  it('a success clears this address+username counter: five fresh tries after it, then locked', async () => {
    const ip = freshIp()
    const { deps, calls } = harness()
    for (let i = 0; i < LOGIN_MAX_FAILURES - 1; i++) await teamLoginAttempt(deps, { ip, username: 'marco.rossi', password: `w${i}` })
    expect((await teamLoginAttempt(deps, { ip, username: 'marco.rossi', password: 'correct-horse' })).ok).toBe(true)
    const before = calls.signIn
    for (let i = 0; i < LOGIN_MAX_FAILURES; i++) expect((await teamLoginAttempt(deps, { ip, username: 'marco.rossi', password: `x${i}` })).error).toBe(INVALID_LOGIN_MESSAGE)
    expect(calls.signIn - before).toBe(LOGIN_MAX_FAILURES)
    expect(locked(await teamLoginAttempt(deps, { ip, username: 'marco.rossi', password: 'x-last' }))).toBe(true)
  })

  it('many colleagues signing in from ONE office address never use up the address total (a success is refunded)', async () => {
    const ip = freshIp()
    const users: Record<string, { id: string; email: string }> = {}
    for (let i = 0; i < 100; i++) users[`user${i}.team`] = { id: `m-${i}`, email: `h${i}@example.test` }
    const { deps, right } = harness({ users })
    for (let i = 0; i < 100; i++) {
      const r = await teamLoginAttempt(deps, { ip, username: `user${i}.team`, password: right })
      expect(r.ok).toBe(true)
    }
    expect(checkLoginRateLimit(teamLoginKeys(ip, null).ipKey).allowed).toBe(true)
  })

  it('an unknown username is counted the same way and answers the same words as a wrong password', async () => {
    const ip = freshIp()
    const { deps, calls } = harness()
    const unknown = await teamLoginAttempt(deps, { ip, username: 'nobody.here', password: 'x' })
    const wrong = await teamLoginAttempt(deps, { ip, username: 'marco.rossi', password: 'x' })
    expect(unknown.error).toBe(wrong.error)
    expect(unknown.error).toBe(INVALID_LOGIN_MESSAGE)
    for (let i = 0; i < LOGIN_MAX_FAILURES - 1; i++) await teamLoginAttempt(deps, { ip, username: 'nobody.here', password: 'x' })
    expect(locked(await teamLoginAttempt(deps, { ip, username: 'nobody.here', password: 'x' }))).toBe(true)
    expect(calls.signIn).toBe(1) // only the one real-login attempt reached a password check
  })

  it('upper-case and padded spellings of a username share the counter with the plain one', async () => {
    const ip = freshIp()
    const { deps, calls } = harness()
    const spellings = ['Marco.Rossi ', 'marco.rossi', ' MARCO.ROSSI', 'marco.rossi', 'Marco.rossi']
    for (const s of spellings) await teamLoginAttempt(deps, { ip, username: s, password: 'w' })
    expect(calls.signIn).toBe(5)
    expect(locked(await teamLoginAttempt(deps, { ip, username: 'MARCO.rossi', password: 'w' }))).toBe(true)
  })

  it('an address that sprays many different usernames is locked at the address total', async () => {
    const ip = freshIp()
    const { deps, calls } = harness()
    let lockedAt = -1
    for (let i = 0; i < IP_MAX_FAILURES + 5; i++) {
      const r = await teamLoginAttempt(deps, { ip, username: `guess${i}.name`, password: 'x' })
      if (locked(r) && lockedAt < 0) lockedAt = i
    }
    expect(lockedAt).toBe(IP_MAX_FAILURES)
    expect(calls.resolve).toBe(IP_MAX_FAILURES)
  })

  it('a failing password service counts as a failed attempt (never as a success)', async () => {
    const ip = freshIp()
    const { deps } = harness()
    deps.signIn = async () => { throw new Error('auth service down') }
    const r = await teamLoginAttempt(deps, { ip, username: 'marco.rossi', password: 'correct-horse' })
    expect(r).toEqual({ ok: false, error: INVALID_LOGIN_MESSAGE })
  })
})

describe('the lockout helper — the additions keep every old behavior', () => {
  it('a per-key cap locks at that cap, and the default stays the old one', () => {
    const k = `cap:${freshIp()}`
    for (let i = 0; i < 3; i++) recordLoginFailure(k, { maxFailures: 3 })
    expect(checkLoginRateLimit(k).allowed).toBe(false)
    const d = `default:${freshIp()}`
    for (let i = 0; i < LOGIN_MAX_FAILURES - 1; i++) recordLoginFailure(d)
    expect(checkLoginRateLimit(d).allowed).toBe(true)
    recordLoginFailure(d)
    expect(checkLoginRateLimit(d).allowed).toBe(false)
  })

  it('releaseLoginAttempt gives one attempt back, drops an empty counter, and leaves a locked key locked', () => {
    const k = `rel:${freshIp()}`
    recordLoginFailure(k); recordLoginFailure(k)
    releaseLoginAttempt(k)
    for (let i = 0; i < LOGIN_MAX_FAILURES - 2; i++) recordLoginFailure(k) // 1 + 3 = 4 counted: still open
    expect(checkLoginRateLimit(k).allowed).toBe(true)
    const e = `empty:${freshIp()}`
    recordLoginFailure(e); releaseLoginAttempt(e); releaseLoginAttempt(e)
    expect(checkLoginRateLimit(e).allowed).toBe(true)
    const l = `locked:${freshIp()}`
    for (let i = 0; i < LOGIN_MAX_FAILURES; i++) recordLoginFailure(l)
    releaseLoginAttempt(l)
    expect(checkLoginRateLimit(l).allowed).toBe(false)
    releaseLoginAttempt(`never-seen:${freshIp()}`) // no entry: nothing happens
  })
})

describe('the wiring', () => {
  it('the login action goes through the guarded flow and no longer keys on the typed string', () => {
    const src = read('app/portal/login/actions.ts')
    expect(src).toMatch(/teamLoginAttempt\(deps,/)
    expect(src).toMatch(/resolve: resolveTeamLoginByUsername/)
    expect(src).toMatch(/limiter: defaultLoginLimiter\(\)/)
    expect(src).not.toMatch(/\.toLowerCase\(\)\.trim\(\)/)
    expect(src).not.toMatch(/resolveAuthEmailForUsername/)
  })

  it('the username lookup validates the spelling before it searches', () => {
    const src = read('lib/portal/team/server.ts')
    const fn = src.slice(src.indexOf('export async function resolveTeamLoginByUsername'))
    expect(fn.slice(0, 700)).toContain('canonicalTeamUsername(username)')
    expect(fn.indexOf('canonicalTeamUsername(username)')).toBeLessThan(fn.indexOf(".ilike('username'"))
  })
})

describe('the username rule, compiled the way production compiles it (R115)', () => {
  const SOURCE = read('lib/portal/team/login-guard.ts')
  async function compiled(target: 'es2017' | 'es5'): Promise<{ canonicalTeamUsername: (v: unknown) => string | null }> {
    const { transform } = await import('next/dist/build/swc')
    const out = await transform(SOURCE, {
      filename: 'login-guard.ts',
      jsc: { parser: { syntax: 'typescript' }, target, minify: { compress: true, mangle: true } },
      module: { type: 'commonjs' },
      minify: true,
      sourceMaps: false,
    })
    const mod = { exports: {} as Record<string, unknown> }
    new Function('module', 'exports', 'require', out.code)(mod, mod.exports, () => { throw new Error('the guard must not import anything') })
    return mod.exports as never
  }
  for (const target of ['es2017', 'es5'] as const) {
    it(`target ${target}: accepts the one form and refuses the star and the percent sign`, async () => {
      const m = await compiled(target)
      expect(m.canonicalTeamUsername('  Marco.Rossi ')).toBe('marco.rossi')
      expect(m.canonicalTeamUsername('marco.rossi*')).toBeNull()
      expect(m.canonicalTeamUsername('marco%')).toBeNull()
      expect(m.canonicalTeamUsername('ab')).toBeNull()
    })
  }
})
