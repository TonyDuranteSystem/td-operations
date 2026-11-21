/**
 * The real wiring of the sign-in counter: the shared counter in the database, with the per-server counter as its fallback.
 * Kept apart from login-limiter.ts so the rules there run in tests without the database client.
 */
import { supabaseAdmin } from '@/lib/supabase-admin'
import { databaseLoginLimiter, layeredLoginLimiter, memoryLoginLimiter, type LoginLimiter } from '@/lib/portal/login-limiter'

let shared: LoginLimiter | null = null

/** One limiter per server instance (it remembers when the shared counter last failed). */
export function defaultLoginLimiter(): LoginLimiter {
  if (!shared) {
    shared = layeredLoginLimiter(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- portal_login_* are not in the generated database types until the production migration is applied
      databaseLoginLimiter((fn, args) => (supabaseAdmin as any).rpc(fn, args)),
      memoryLoginLimiter(),
    )
  }
  return shared
}
