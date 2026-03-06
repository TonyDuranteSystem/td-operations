/**
 * Supabase Admin Client (Service Role)
 * Bypasses Row Level Security for server-side operations.
 * Used by: MCP tools, API routes, cron jobs
 */

import { createClient } from '@supabase/supabase-js'

export const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)
