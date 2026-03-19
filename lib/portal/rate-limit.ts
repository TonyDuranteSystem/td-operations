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
