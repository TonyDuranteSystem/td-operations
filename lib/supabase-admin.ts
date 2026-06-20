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
      const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!

      // Hardcoded production ref — never allowed in local/non-Vercel environments.
      // This is independent of EXPECTED_SUPABASE_REF: even if the entire .env.local
      // was pulled from production (so both URL and EXPECTED_SUPABASE_REF match
      // production), this check still fires and blocks the server from starting.
      // process.env.VERCEL is set by Vercel at deploy time; it is absent locally.
      if (!process.env.VERCEL && supabaseUrl.includes('ydzipybqeebtpcvsbtvs')) {
        throw new Error(
          '\n⛔ FATAL: Local environment is connected to PRODUCTION Supabase (ydzipybqeebtpcvsbtvs).\n' +
          'Running local code against production is forbidden.\n' +
          'Fix: bash scripts/dev-setup.sh\n'
        )
      }

      const expectedRef = process.env.EXPECTED_SUPABASE_REF
      if (expectedRef) {
        const actualRef = supabaseUrl.match(/https:\/\/([^.]+)\.supabase\.co/)?.[1]
        if (actualRef !== expectedRef) {
          throw new Error(`Supabase project ref mismatch: expected "${expectedRef}", got "${actualRef}". Refusing to start — wrong DB target.`)
        }
      }
      _supabaseAdmin = createClient<Database>(
        supabaseUrl,
        process.env.SUPABASE_SERVICE_ROLE_KEY!,
        {
          global: {
            // Force every PostgREST/Storage request through an uncached fetch.
            // Next.js patches global fetch and, in PRODUCTION (Vercel), caches GET
            // responses in its Data Cache — so server-side reads (e.g. the flow
            // document list) could be served STALE even though the route is
            // `force-dynamic`. This manifested as "documents not showing" on
            // sandbox while working in local dev (dev does not use the Data Cache).
            // A service-role admin client must NEVER read stale data.
            fetch: (input: RequestInfo | URL, init?: RequestInit) =>
              fetch(input, { ...init, cache: 'no-store' }),
          },
        },
      )
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (_supabaseAdmin as any)[prop]
  },
})
