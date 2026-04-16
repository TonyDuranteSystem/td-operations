/**
 * P1.9 — Supabase auth admin helpers that survive past 1000 users.
 *
 * Background:
 * 25 call sites across 15 files use the pattern
 *   `listUsers({ perPage: 1000 }).find(u => u.email === email)`
 * which silently returns wrong / no user once auth.users exceeds 1000.
 * Production count on 2026-04-16 is 211, so we're safe today — but at
 * current growth rate the cap is reachable within a year, and the
 * failure mode is silent (user lookups return undefined, the caller
 * creates a duplicate or falls through to an error path) with no alert.
 *
 * This helper paginates through listUsers properly until the user is
 * found or pages are exhausted. Call sites migrate from:
 *
 *   const { data: { users } } = await supabaseAdmin.auth.admin
 *     .listUsers({ perPage: 1000 })
 *   const user = users.find(u => u.email === email)
 *
 * to:
 *
 *   const user = await findAuthUserByEmail(email)
 *
 * Also exposes `findAuthUserById` (a trivial wrapper over
 * getUserById) for symmetry — most call sites looking up by id can
 * use getUserById directly.
 */

import type { User } from "@supabase/supabase-js"
import { supabaseAdmin } from "@/lib/supabase-admin"

const DEFAULT_PER_PAGE = 1000
const MAX_PAGES = 20 // safety cap: 20 pages × 1000 users = 20k users

/**
 * Find an auth user by email, paginating through listUsers as needed.
 * Returns null if no user matches.
 *
 * Email matching is case-insensitive (matches Supabase's canonical
 * lower-cased storage) but the caller should pass a trimmed lowercase
 * email for exact-match performance.
 */
export async function findAuthUserByEmail(
  email: string,
): Promise<User | null> {
  if (!email) return null
  const normalized = email.toLowerCase().trim()
  let page = 1
  while (page <= MAX_PAGES) {
    const { data, error } = await supabaseAdmin.auth.admin.listUsers({
      page,
      perPage: DEFAULT_PER_PAGE,
    })
    if (error) {
      throw new Error(
        `findAuthUserByEmail: listUsers page=${page} failed: ${error.message}`,
      )
    }
    const users = (data?.users ?? []) as User[]
    const found = users.find(
      (u) => (u.email ?? "").toLowerCase() === normalized,
    )
    if (found) return found
    // Pagination type is `nextPage: number | null`. Stop when it's null
    // or when this page came back short (Supabase does not always
    // populate nextPage reliably, so the length heuristic backs it up).
    const pagination = data as unknown as { nextPage?: number | null }
    const hasMore =
      pagination?.nextPage !== null &&
      users.length >= DEFAULT_PER_PAGE
    if (!hasMore) return null
    page += 1
  }
  return null
}

/**
 * Find an auth user by id via the direct `getUserById` endpoint. Thin
 * wrapper so call sites import from one place; avoids the listUsers
 * pattern entirely when the caller already has the uuid.
 */
export async function findAuthUserById(id: string): Promise<User | null> {
  if (!id) return null
  const { data, error } = await supabaseAdmin.auth.admin.getUserById(id)
  if (error) {
    // The admin API returns a 404-shaped error for "not found"; treat
    // it as null instead of throwing so the call-site code path stays
    // the same as the listUsers pattern.
    if ((error as { status?: number }).status === 404) return null
    throw new Error(`findAuthUserById: getUserById failed: ${error.message}`)
  }
  return (data?.user ?? null) as User | null
}

/**
 * List all auth users across pages. For endpoints that genuinely need
 * every row (team-management GET, bulk audits). Stops at MAX_PAGES as
 * a runaway guard — if the team ever exceeds 20k users, raise the cap
 * deliberately.
 */
export async function listAllAuthUsers(): Promise<User[]> {
  const all: User[] = []
  let page = 1
  while (page <= MAX_PAGES) {
    const { data, error } = await supabaseAdmin.auth.admin.listUsers({
      page,
      perPage: DEFAULT_PER_PAGE,
    })
    if (error) {
      throw new Error(
        `listAllAuthUsers: listUsers page=${page} failed: ${error.message}`,
      )
    }
    const users = (data?.users ?? []) as User[]
    all.push(...users)
    const pagination = data as unknown as { nextPage?: number | null }
    const hasMore =
      pagination?.nextPage !== null &&
      users.length >= DEFAULT_PER_PAGE
    if (!hasMore) break
    page += 1
  }
  return all
}
