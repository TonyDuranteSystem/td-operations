/**
 * WhatsApp voice notes — the 180-day retention sweep (Antonio 2026-09-26: keep the audio 180 days, the transcript forever).
 * Deletes the audio FILE of every voice note whose audio is older than RETENTION_DAYS, then records that (storage_path cleared,
 * audio_deleted_at set). The transcript stays. The file is removed BEFORE the row is touched: if removal fails the row keeps its
 * path and the next run tries again (never a row that says "deleted" while the file still exists).
 *
 * Auth: CRON_SECRET Bearer — FAILS CLOSED when the secret is unset. Schedule: vercel.json daily, kept in sync with lib/cron-coverage.ts.
 */

export const dynamic = "force-dynamic"

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { logCron } from "@/lib/cron-log"
import { RETENTION_DAYS, VOICE_BUCKET } from "@/lib/messaging/wabridge-media"

const ENDPOINT = "/api/cron/wa-media-retention"

function isAuthorized(req: NextRequest): boolean {
  const cronSecret = process.env.CRON_SECRET
  if (!cronSecret) return false
  return req.headers.get("authorization") === `Bearer ${cronSecret}`
}

async function handle(req: NextRequest): Promise<NextResponse> {
  const start = Date.now()
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }
  try {
    const { data: due, error } = await supabaseAdmin.rpc("wabridge_media_expired_list", { p_days: RETENTION_DAYS, p_limit: 200 })
    if (error) throw error
    const items = (Array.isArray(due) ? due : []) as Array<{ message_id?: string; path?: string }>
    const valid = items.filter((i) => typeof i.message_id === "string" && typeof i.path === "string" && i.path.startsWith("voice/"))

    let deleted = 0
    if (valid.length > 0) {
      const { error: removeError } = await supabaseAdmin.storage.from(VOICE_BUCKET).remove(valid.map((i) => i.path as string))
      if (removeError) throw removeError
      const { data: marked, error: markError } = await supabaseAdmin.rpc("wabridge_media_mark_deleted", { p_message_ids: valid.map((i) => i.message_id as string) })
      if (markError) throw markError
      deleted = typeof marked === "number" ? marked : 0
    }
    logCron({ endpoint: ENDPOINT, status: "success", duration_ms: Date.now() - start, details: { due: valid.length, deleted } })
    return NextResponse.json({ ok: true, due: valid.length, deleted })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logCron({ endpoint: ENDPOINT, status: "error", duration_ms: Date.now() - start, error_message: message })
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

export async function GET(req: NextRequest) {
  return handle(req)
}
