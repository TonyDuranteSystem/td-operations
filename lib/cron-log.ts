/**
 * Cron execution logger — writes to cron_log table.
 * Fire-and-forget (never blocks the cron response).
 */

import { createClient } from "@supabase/supabase-js"

interface CronLogEntry {
  endpoint: string
  status: "success" | "error"
  duration_ms: number
  error_message?: string
  details?: Record<string, unknown>
}

export function logCron(entry: CronLogEntry): void {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )

  Promise.resolve(
    supabase.from("cron_log").insert({
      endpoint: entry.endpoint,
      status: entry.status,
      duration_ms: entry.duration_ms,
      error_message: entry.error_message || null,
      details: entry.details || {},
    })
  ).catch(() => {})
}
