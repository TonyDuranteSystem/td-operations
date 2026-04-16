/**
 * P1.3 — dbWrite wrapper with Sentry capture
 *
 * Wraps Supabase .insert() / .update() / .delete() / .upsert() calls.
 * Destructures `error`, captures to Sentry in production, and throws on failure.
 *
 * Usage:
 *   import { dbWrite } from "@/lib/db"
 *
 *   const rows = await dbWrite(
 *     supabaseAdmin.from("accounts").update({ status: "Active" }).eq("id", accountId).select(),
 *     "accounts.update"
 *   )
 *
 * The second argument is a label for Sentry context (table.operation).
 */

import * as Sentry from "@sentry/nextjs"

type SupabaseResponse<T> = {
  data: T | null
  error: { message: string; code?: string; details?: string; hint?: string } | null
}

/**
 * Wraps a Supabase write operation. Throws on error, captures to Sentry.
 * Returns the data on success (never null — throws instead).
 */
export async function dbWrite<T>(
  query: PromiseLike<SupabaseResponse<T>>,
  label: string
): Promise<T> {
  const { data, error } = await query

  if (error) {
    Sentry.captureException(new Error(`dbWrite[${label}]: ${error.message}`), {
      extra: {
        label,
        code: error.code,
        details: error.details,
        hint: error.hint,
      },
    })
    throw new Error(`dbWrite[${label}]: ${error.message}`)
  }

  // data can legitimately be null for mutations without .select()
  return data as T
}

/**
 * Like dbWrite but does not throw — returns { data, error } for cases
 * where the caller wants to handle the error themselves.
 * Still captures to Sentry on error.
 */
export async function dbWriteSafe<T>(
  query: PromiseLike<SupabaseResponse<T>>,
  label: string
): Promise<{ data: T | null; error: string | null }> {
  const { data, error } = await query

  if (error) {
    Sentry.captureException(new Error(`dbWrite[${label}]: ${error.message}`), {
      extra: {
        label,
        code: error.code,
        details: error.details,
        hint: error.hint,
      },
    })
    return { data: null, error: error.message }
  }

  return { data, error: null }
}
