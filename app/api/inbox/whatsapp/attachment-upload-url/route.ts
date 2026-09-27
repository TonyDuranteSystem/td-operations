import { NextRequest, NextResponse } from "next/server"
import { requireStaffRoute } from "@/lib/auth/require-staff-route"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { validateOutboundAttachment, buildOutboundPath, WA_OUTBOUND_BUCKET } from "@/lib/messaging/wabridge-attachment"

export const dynamic = "force-dynamic"

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * POST /api/inbox/whatsapp/attachment-upload-url   { groupId, clientMsgId, fileName, fileSize, mimeType }
 *
 * Step 1 of sending an attachment/voice note from the CRM: mints a signed direct-to-Storage upload URL at a
 * SERVER-BUILT, deterministic path (channel + client message id — never chosen by the browser), so a retry with
 * the same client message id can never store two different files. Every rule (dangerous file type, supported
 * mime, size ceiling) is checked here, BEFORE any bytes move — the enqueue step in /attachment-send re-verifies
 * the object actually landed rather than trusting this call alone. Staff only.
 */
export async function POST(req: NextRequest) {
  const denied = await requireStaffRoute()
  if (denied) return denied

  const body = (await req.json().catch(() => ({}))) as {
    groupId?: unknown
    clientMsgId?: unknown
    fileName?: unknown
    fileSize?: unknown
    mimeType?: unknown
  }
  if (typeof body.groupId !== "string" || !UUID_RE.test(body.groupId)) {
    return NextResponse.json({ error: "groupId is required" }, { status: 400 })
  }
  if (typeof body.clientMsgId !== "string" || body.clientMsgId.length < 8 || body.clientMsgId.length > 100) {
    return NextResponse.json({ error: "clientMsgId is required" }, { status: 400 })
  }

  const validation = validateOutboundAttachment({
    fileName: typeof body.fileName === "string" ? body.fileName : null,
    fileSize: typeof body.fileSize === "number" ? body.fileSize : NaN,
    mimeType: typeof body.mimeType === "string" ? body.mimeType : null,
  })
  if (!validation.ok) {
    return NextResponse.json({ error: validation.error }, { status: 400 })
  }

  const { data: group, error: groupError } = await supabaseAdmin
    .from("messaging_groups")
    .select("channel_id")
    .eq("id", body.groupId)
    .maybeSingle()
  if (groupError) return NextResponse.json({ error: "Could not look up this conversation." }, { status: 500 })
  if (!group) return NextResponse.json({ error: "Conversation not found." }, { status: 404 })

  const { data: channel } = await supabaseAdmin.from("messaging_channels").select("provider").eq("id", group.channel_id).maybeSingle()
  if (channel?.provider !== "wabridge") {
    return NextResponse.json({ error: "Attachments can only be sent on the self-hosted WhatsApp line." }, { status: 409 })
  }

  const path = buildOutboundPath(group.channel_id, body.clientMsgId, typeof body.mimeType === "string" ? body.mimeType : null)
  const { data: signed, error: signError } = await supabaseAdmin.storage.from(WA_OUTBOUND_BUCKET).createSignedUploadUrl(path, { upsert: true })
  if (signError || !signed?.signedUrl) {
    return NextResponse.json({ error: "Could not start the upload — please try again." }, { status: 500 })
  }
  return NextResponse.json({ signedUrl: signed.signedUrl, token: signed.token, path, kind: validation.kind })
}
