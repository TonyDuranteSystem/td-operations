import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { requireStaffRoute } from "@/lib/auth/require-staff-route"
import { PLAYBACK_URL_SECONDS, VOICE_BUCKET } from "@/lib/messaging/wabridge-media"

export const dynamic = "force-dynamic"

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * GET /api/inbox/whatsapp/voice/[messageId]  →  { url }   a short-lived link to play ONE voice note.
 *
 * OPEN TO ANYONE WHO CAN USE THE INBOX (Antonio 2026-11-04 — this reversed his 2026-09-26 "staff only" rule for voice notes):
 * requireStaffRoute still keeps portal CLIENTS out; a partner or marketing login is no longer refused here. (A marketing login
 * is walled into /marketing by the middleware door rule and never reaches this route.) Photos and documents keep the old
 * staff-only rule in the messages route. The private bucket has no public URL; a fresh signed link is minted per play, valid a
 * few minutes, never stored, and the response is never cached. The audio path comes from the database row, never from the request.
 */
export async function GET(_req: NextRequest, { params }: { params: { messageId: string } }) {
  const denied = await requireStaffRoute()
  if (denied) return denied

  if (!UUID_RE.test(params.messageId)) {
    return NextResponse.json({ error: "Not found." }, { status: 404, headers: { "Cache-Control": "no-store" } })
  }

  const { data: media, error } = await supabaseAdmin
    .from("message_media")
    .select("status, storage_path, audio_deleted_at")
    .eq("message_id", params.messageId)
    .maybeSingle()
  if (error) return NextResponse.json({ error: "Could not load the audio." }, { status: 500, headers: { "Cache-Control": "no-store" } })
  if (!media || media.status !== "ready" || !media.storage_path || media.audio_deleted_at) {
    return NextResponse.json({ error: "This audio is not available." }, { status: 404, headers: { "Cache-Control": "no-store" } })
  }

  const { data: signed, error: signError } = await supabaseAdmin.storage.from(VOICE_BUCKET).createSignedUrl(media.storage_path, PLAYBACK_URL_SECONDS)
  if (signError || !signed?.signedUrl) {
    return NextResponse.json({ error: "Could not load the audio." }, { status: 500, headers: { "Cache-Control": "no-store" } })
  }
  return NextResponse.json({ url: signed.signedUrl }, { headers: { "Cache-Control": "no-store" } })
}
