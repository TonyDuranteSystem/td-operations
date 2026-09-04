import { createClient } from "@/lib/supabase/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { isDashboardUser } from "@/lib/auth"
import { capturesTable } from "@/lib/captures/db"
import { WORKER_UPLOAD_BUCKET } from "@/lib/captures/storage"
import { NextRequest, NextResponse } from "next/server"
import { randomUUID } from "crypto"

/**
 * POST /api/captures/[id]/share-team-chat
 *
 * Sends an already-uploaded capture into a specific Team Chat thread, as a
 * real attachment — "works exactly like any file shared there today"
 * (Antonio, 2026-09-04). Team Chat is staff-only, never client-visible, and
 * every existing attachment there already lives in the public `assets`
 * bucket (same risk profile every other team-chat file already carries) —
 * unlike the sticky-note destination, there is no "private" promise here to
 * protect, so this step COPIES the capture's bytes out of the private
 * worker-attachments bucket into `assets` under team-chat's own path
 * convention, then delivers it exactly the way a human attaching a file
 * there today would.
 *
 * Deliberately does NOT use lib/team/post-message.ts's postTeamMessage() —
 * that choke-point always stamps the sender as the CLAUDE sentinel identity
 * (its own header: "the sender is always the CLAUDE sentinel... never a
 * session user"). A real person sharing their own screenshot must show up
 * as themselves, not as the AI. Instead this calls the real human send route
 * (POST /api/team/threads/[id]/messages) internally, forwarding this
 * request's own session cookie, so identity/push/mentions all come from the
 * one already-hardened path humans use — not a second, duplicated copy of
 * that logic that could quietly drift from it.
 *
 * ⚠️ The internal call's base URL is deliberately NOT lib/config.ts's
 * APP_BASE_URL — that constant is the public brand domain, meant for
 * CLIENT-facing links, and is hardcoded to production when no sandbox
 * override is configured (confirmed live, 2026-09-04: calling it from this
 * sandbox worktree sent the request to the real production site carrying a
 * sandbox session cookie, which production's own Supabase project correctly
 * rejected as invalid — a genuine bug caught by testing this in the browser,
 * not assumed to work from reading the code). Uses this SAME incoming
 * request's own origin instead (request.nextUrl.origin) — always the
 * correct host:port for calling back into the same running deployment, in
 * every environment (any local dev port, sandbox, production) with no
 * hardcoded fallback to get wrong. The codebase's one other same-deployment
 * self-call (app/api/portal/invoices/[id]/send/route.ts) instead derives
 * this from Vercel's own VERCEL_URL with a hardcoded localhost:3000
 * fallback — which would have been equally wrong here, since this worktree's
 * dev server runs on a different port.
 */
export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  const supabase = createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user || !isDashboardUser(user)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 403 })
  }

  const captureId = params.id
  const body = await request.json().catch(() => ({}))
  const threadId = typeof body.thread_id === "string" ? body.thread_id : ""
  if (!threadId) return NextResponse.json({ error: "Which conversation?" }, { status: 400 })

  const { data: capture, error: captureErr } = await capturesTable()
    .select("id, image_url, image_name, mime_type, size_bytes, note, title, captured_by_user_id")
    .eq("id", captureId)
    .single()
  if (captureErr || !capture) return NextResponse.json({ error: "That capture is gone. Please try again." }, { status: 404 })
  if (capture.captured_by_user_id !== user.id) {
    return NextResponse.json({ error: "That isn't your capture." }, { status: 403 })
  }

  // Thread must exist (same cheap guard the existing team upload-url route uses).
  const { data: thread } = await supabaseAdmin.from("internal_threads").select("id").eq("id", threadId).single()
  if (!thread) return NextResponse.json({ error: "That conversation is gone. Please try again." }, { status: 404 })

  // Copy: download from the private bucket, upload into the public one team
  // chat already uses — same download-then-upload shape as this codebase's
  // one other cross-bucket copy (lib/td-communication/copy-to-public.ts).
  const { data: blob, error: dlErr } = await supabaseAdmin.storage.from(WORKER_UPLOAD_BUCKET).download(capture.image_url)
  if (dlErr || !blob) {
    console.error("[captures/share-team-chat] download error:", dlErr)
    return NextResponse.json({ error: "Could not read the picture. Please try again." }, { status: 500 })
  }
  const buffer = Buffer.from(await blob.arrayBuffer())
  const ext = (capture.image_name?.split(".").pop() || "png").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 8) || "png"
  const assetsPath = `team-chat/${threadId}/${randomUUID()}.${ext}`
  const { error: upErr } = await supabaseAdmin.storage
    .from("assets")
    .upload(assetsPath, buffer, { contentType: capture.mime_type || "image/png", upsert: false })
  if (upErr) {
    console.error("[captures/share-team-chat] upload error:", upErr)
    return NextResponse.json({ error: "Could not share the picture. Please try again." }, { status: 500 })
  }
  const { data: urlData } = supabaseAdmin.storage.from("assets").getPublicUrl(assetsPath)

  // Deliver through the real human send route — same identity, push, and
  // mention handling every other team-chat message already gets.
  const message = (capture.note?.trim() || capture.title || "Shared a screenshot").slice(0, 5000)
  let sendRes: Response
  try {
    sendRes = await fetch(`${request.nextUrl.origin}/api/team/threads/${threadId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: request.headers.get("cookie") || "" },
      body: JSON.stringify({
        message,
        attachments: [
          {
            url: urlData.publicUrl,
            name: capture.image_name || "screenshot.png",
            mime_type: capture.mime_type || "image/png",
            size: capture.size_bytes != null ? Number(capture.size_bytes) : undefined,
          },
        ],
      }),
    })
  } catch (err) {
    console.error("[captures/share-team-chat] send route unreachable:", err)
    return NextResponse.json({ error: "Could not reach team chat. Please try again." }, { status: 500 })
  }
  if (!sendRes.ok) {
    const d = await sendRes.json().catch(() => ({}))
    return NextResponse.json({ error: d.error || "Could not send to team chat." }, { status: sendRes.status })
  }
  const sendData = await sendRes.json().catch(() => ({}))

  // Best-effort — the message above is what actually matters; a failure here
  // only leaves the capture folder's "where it went" label stale.
  await capturesTable()
    .update({ destination: { type: "team_chat", id: threadId, label: message.slice(0, 60) } })
    .eq("id", captureId)

  return NextResponse.json({ ok: true, message_id: sendData.message?.id ?? null })
}
