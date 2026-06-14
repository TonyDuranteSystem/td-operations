/**
 * Simple in-memory rate limiter for portal API routes.
 * Tracks requests per IP per route. Resets after the window expires.
 * For Vercel serverless: each instance has its own memory, so this
 * is approximate — but good enough to prevent obvious abuse.
 */

interface RateLimitEntry {
  count: number
  resetAt: number
}

const store = new Map<string, RateLimitEntry>()

// Clean up expired entries every 5 minutes
setInterval(() => {
  const now = Date.now()
  store.forEach((entry, key) => {
    if (now > entry.resetAt) store.delete(key)
  })
}, 5 * 60 * 1000)

/**
 * Check rate limit for a given key (typically IP + route).
 * Returns { allowed: true } if under limit, or { allowed: false, retryAfter } if over.
 */
export function checkRateLimit(
  key: string,
  maxRequests: number = 30,
  windowMs: number = 60_000 // 1 minute
): { allowed: boolean; retryAfter?: number } {
  const now = Date.now()
  const entry = store.get(key)

  if (!entry || now > entry.resetAt) {
    store.set(key, { count: 1, resetAt: now + windowMs })
    return { allowed: true }
  }

  entry.count++
  if (entry.count > maxRequests) {
    return { allowed: false, retryAfter: Math.ceil((entry.resetAt - now) / 1000) }
  }

  return { allowed: true }
}

/**
 * Helper to get rate limit key from request (IP + pathname).
 */
export function getRateLimitKey(request: Request): string {
  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    || request.headers.get('x-real-ip')
    || 'unknown'
  const url = new URL(request.url)
  return `${ip}:${url.pathname}`
}

// ─── Login brute-force protection ───────────────────────────────────────────
// Tracks FAILED auth attempts per key (IP + identifier). After
// LOGIN_MAX_FAILURES failures the key is locked for LOGIN_LOCK_MS. A successful
// login clears the counter. Separate from checkRateLimit (which counts every
// request) because we only want to penalize FAILURES, not normal traffic.
//
// Security audit 2026-06-13 (H10). In-memory per serverless instance — a
// best-effort guard against obvious brute force, not a distributed limiter.

export const LOGIN_MAX_FAILURES = 5
export const LOGIN_LOCK_MS = 15 * 60 * 1000 // 15 minutes

interface LoginEntry {
  failures: number
  firstAt: number
  lockedUntil: number
}

const loginStore = new Map<string, LoginEntry>()

// Reuse the same 5-minute sweep cadence to drop fully-expired entries.
setInterval(() => {
  const now = Date.now()
  loginStore.forEach((entry, key) => {
    const expiry = entry.lockedUntil || entry.firstAt + LOGIN_LOCK_MS
    if (now > expiry) loginStore.delete(key)
  })
}, 5 * 60 * 1000)

/**
 * Check whether a login key is currently locked out.
 * Call BEFORE attempting authentication.
 */
export function checkLoginRateLimit(key: string): { allowed: boolean; retryAfter?: number } {
  const now = Date.now()
  const entry = loginStore.get(key)
  if (!entry) return { allowed: true }

  // Expired lock / window → reset.
  if (entry.lockedUntil && now >= entry.lockedUntil) {
    loginStore.delete(key)
    return { allowed: true }
  }
  if (entry.lockedUntil && now < entry.lockedUntil) {
    return { allowed: false, retryAfter: Math.ceil((entry.lockedUntil - now) / 1000) }
  }
  return { allowed: true }
}

/**
 * Record a FAILED login attempt. Locks the key once failures reach the cap.
 * Call AFTER an authentication attempt that failed.
 */
export function recordLoginFailure(key: string): void {
  const now = Date.now()
  const entry = loginStore.get(key)
  if (!entry || now > entry.firstAt + LOGIN_LOCK_MS) {
    loginStore.set(key, { failures: 1, firstAt: now, lockedUntil: 0 })
    return
  }
  entry.failures += 1
  if (entry.failures >= LOGIN_MAX_FAILURES) {
    entry.lockedUntil = now + LOGIN_LOCK_MS
  }
}

/** Clear the failure counter for a key after a SUCCESSFUL login. */
export function clearLoginFailures(key: string): void {
  loginStore.delete(key)
}
