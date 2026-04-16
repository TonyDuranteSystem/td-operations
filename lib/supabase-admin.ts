/**
 * Supabase Admin Client (Service Role)
 * Bypasses Row Level Security for server-side operations.
 * Used by: MCP tools, API routes, cron jobs
 *
 * Lazy-initialized to avoid build-time crash when env vars are not available.
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/database.types'

let _supabaseAdmin: SupabaseClient<Database> | null = null

// eslint-disable-next-line no-restricted-syntax -- this is the canonical typed client
export const supabaseAdmin = new Proxy({} as SupabaseClient<Database>, {
  get(_target, prop) {
    if (!_supabaseAdmin) {
      _supabaseAdmin = createClient<Database>(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.SUPABASE_SERVICE_ROLE_KEY!
      )
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (_supabaseAdmin as any)[prop]
  },
})
