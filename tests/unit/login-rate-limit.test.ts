import { describe, it, expect } from 'vitest'
import {
  checkLoginRateLimit,
  recordLoginFailure,
  clearLoginFailures,
  LOGIN_MAX_FAILURES,
} from '@/lib/portal/rate-limit'

describe('login rate limiter', () => {
  it('allows attempts until the failure cap is reached', () => {
    const key = 'test:allow:' + Math.round(performance.now())
    for (let i = 0; i < LOGIN_MAX_FAILURES - 1; i++) {
      expect(checkLoginRateLimit(key).allowed).toBe(true)
      recordLoginFailure(key)
    }
    // Still allowed right before the cap.
    expect(checkLoginRateLimit(key).allowed).toBe(true)
  })

  it('locks out after the cap and reports retryAfter', () => {
    const key = 'test:lock:' + Math.round(performance.now())
    for (let i = 0; i < LOGIN_MAX_FAILURES; i++) recordLoginFailure(key)
    const res = checkLoginRateLimit(key)
    expect(res.allowed).toBe(false)
    expect(res.retryAfter).toBeGreaterThan(0)
  })

  it('clears the counter after a successful login', () => {
    const key = 'test:clear:' + Math.round(performance.now())
    for (let i = 0; i < LOGIN_MAX_FAILURES; i++) recordLoginFailure(key)
    expect(checkLoginRateLimit(key).allowed).toBe(false)
    clearLoginFailures(key)
    expect(checkLoginRateLimit(key).allowed).toBe(true)
  })

  it('keys are independent', () => {
    const a = 'test:a:' + Math.round(performance.now())
    const b = 'test:b:' + Math.round(performance.now())
    for (let i = 0; i < LOGIN_MAX_FAILURES; i++) recordLoginFailure(a)
    expect(checkLoginRateLimit(a).allowed).toBe(false)
    expect(checkLoginRateLimit(b).allowed).toBe(true)
  })
})
