/**
 * Supabase Admin Client (Service Role)
 * Bypasses Row Level Security for server-side operations.
 * Used by: MCP tools, API routes, cron jobs
 *
 * Lazy-initialized to avoid build-time crash when env vars are not available.
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js'

let _supabaseAdmin: SupabaseClient | null = null

export const supabaseAdmin = new Proxy({} as SupabaseClient, {
  get(_target, prop) {
    if (!_supabaseAdmin) {
      _supabaseAdmin = createClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.SUPABASE_SERVICE_ROLE_KEY!
      )
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (_supabaseAdmin as any)[prop]
  },
})
