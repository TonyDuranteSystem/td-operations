import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { findOrCreateWhatsAppGroup } from "@/lib/messaging/groups"
import type { Json } from "@/lib/database.types"
import {
  isFreshTs,
  normalizeBackfillItem,
  parseGowaEvent,
  verifyGowaSignature,
  type WabridgeMessage,
} from "@/lib/messaging/wabridge"
import { parseHeartbeat } from "@/lib/messaging/wabridge-health"

export const dynamic = "force-dynamic"
export const maxDuration = 60

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_BODY_BYTES = 2_000_000
const MAX_BACKFILL_ITEMS = 200
const MAX_NAME_ITEMS = 500

/**
 * POST /api/wa-bridge/[channelId]
 *
 * Receiver for our own WhatsApp bridge (GOWA linked-device program on the Mac Mini, provider
 * 'wabridge'). One URL per channel; every request body is signed HMAC-SHA256 with the channel's
 * `webhook_secret` (header X-Hub-Signature-256) — fail-closed: a channel with no secret accepts nothing.
 *
 * Event kinds on this one URL:
 *  - (GOWA's own webhook)  {event:"message", ...}     live message → saved
 *  - {event:"bridge.heartbeat", ts, reachable, connected, logged_in}   health beat from the Mac (ts must be fresh)
 *  - {event:"bridge.backfill", ts, items:[BackfillItem], live?}       history download batch (no unread, no revive);
 *                                                                     live:true = a recent CATCH-UP of messages the live path missed → treated as live (unread + revive)
 *  - {event:"bridge.names", ts, names:[{digits,name}]}                the phone's saved contact names
 *
 * Response contract with GOWA (it retries a non-2xx up to 5 times over ~30s, then DROPS the event):
 *  - 404 unknown/malformed/non-bridge channel, 401 bad signature → not worth retrying
 *  - 200 for everything intentionally ignored (see lib/messaging/wabridge.ts)
 *  - 500 for a real database failure → retried, and the dedupe below makes the retry safe
 */
export async function POST(req: NextRequest, { params }: { params: { channelId: string } }) {
  const { channelId } = params
  // A non-UUID would make Postgres answer 22P02 → a 500 that GOWA would retry; it is simply not a channel.
  if (!UUID_RE.test(channelId)) {
    return NextResponse.json({ error: "Unknown channel" }, { status: 404 })
  }
  if (Number(req.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "Payload too large" }, { status: 413 })
  }

  const { data: channel, error: channelError } = await supabaseAdmin
    .from("messaging_channels")
    .select("id, provider, is_active, webhook_secret")
    .eq("id", channelId)
    .maybeSingle()

  if (channelError) {
    return NextResponse.json({ error: "Channel lookup failed" }, { status: 500 })
  }
  if (!channel || channel.provider !== "wabridge") {
    return NextResponse.json({ error: "Unknown channel" }, { status: 404 })
  }

  const rawBody = await req.text()
  if (rawBody.length > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "Payload too large" }, { status: 413 })
  }
  if (!channel.webhook_secret || !verifyGowaSignature(rawBody, req.headers.get("x-hub-signature-256"), channel.webhook_secret)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }
  if (!channel.is_active) {
    return NextResponse.json({ ok: true, skipped: "channel inactive" })
  }

  let body: unknown
  try {
    body = JSON.parse(rawBody)
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }
  const now = new Date()
  const kind = typeof body === "object" && body !== null ? (body as Record<string, unknown>).event : undefined

  // ─── Health beat from the Mac (GOWA itself emits no connect/disconnect event) ───
  if (kind === "bridge.heartbeat") {
    const hb = parseHeartbeat(body, now)
    if (!hb) return NextResponse.json({ error: "bad heartbeat" }, { status: 400 })
    if (hb.ok === false) return NextResponse.json({ error: hb.reason }, { status: 400 })
    const { error: hbError } = await supabaseAdmin.rpc("wabridge_record_heartbeat", {
      p_channel_id: channel.id,
      p_reachable: hb.reachable,
      p_connected: hb.connected,
      p_logged_in: hb.logged_in,
    })
    if (hbError) return NextResponse.json({ error: hbError.message }, { status: 500 })
    return NextResponse.json({ ok: true, heartbeat: true })
  }

  // ─── The phone's saved contact names → chat names ───
  if (kind === "bridge.names") {
    const b = body as { ts?: unknown; names?: unknown }
    if (!isFreshTs(b.ts, now, 10 * 60_000) || !Array.isArray(b.names) || b.names.length > MAX_NAME_ITEMS) {
      return NextResponse.json({ error: "Invalid names batch" }, { status: 400 })
    }
    const { data: updated, error: namesError } = await supabaseAdmin.rpc("wabridge_apply_names", {
      p_channel_id: channel.id,
      p_names: b.names as Json,
    })
    if (namesError) return NextResponse.json({ error: namesError.message }, { status: 500 })
    return NextResponse.json({ ok: true, updated: updated ?? 0 })
  }

  // ─── History download: old messages from the phone's chats (no unread, no un-hiding) ───
  if (kind === "bridge.backfill") {
    const b = body as { ts?: unknown; items?: unknown; live?: unknown }
    if (!isFreshTs(b.ts, now, 10 * 60_000) || !Array.isArray(b.items) || b.items.length > MAX_BACKFILL_ITEMS) {
      return NextResponse.json({ error: "Invalid backfill batch" }, { status: 400 })
    }
    const groupCache = new Map<string, string>()
    let inserted = 0
    let deduped = 0
    let skipped = 0
    for (const raw of b.items) {
      const m = normalizeBackfillItem(raw, now)
      if (!m) {
        skipped++
        continue
      }
      const r = await ingest(channel.id, m, b.live !== true, groupCache)
      if (r === "error") return NextResponse.json({ error: "ingest failed" }, { status: 500 })
      if (r === "inserted") inserted++
      else deduped++
    }
    return NextResponse.json({ ok: true, inserted, deduped, skipped })
  }

  // ─── A live message (GOWA's own webhook) ───
  const parsed = parseGowaEvent(body, now)
  if (parsed.action === "ignore") {
    // A real person WhatsApp identified only by a hidden id can't become a thread — but never silently.
    if (parsed.code === "lid") {
      await supabaseAdmin.rpc("wabridge_count_dropped", { p_channel_id: channel.id })
    }
    return NextResponse.json({ ok: true, skipped: parsed.reason })
  }
  const r = await ingest(channel.id, parsed.message, false, new Map())
  if (r === "error") return NextResponse.json({ error: "ingest failed" }, { status: 500 })
  return NextResponse.json(r === "inserted" ? { ok: true } : { ok: true, deduped: true })
}

/** Find/create the chat, then save the message + conversation update in one DB transaction. */
async function ingest(
  channelId: string,
  m: WabridgeMessage,
  backfill: boolean,
  groupCache: Map<string, string>,
): Promise<"inserted" | "deduped" | "error"> {
  let groupId = groupCache.get(m.remoteDigits)
  if (!groupId) {
    const groupResult = await findOrCreateWhatsAppGroup({
      channelId,
      remoteIdentifier: m.remoteDigits,
      groupName: m.direction === "inbound" ? m.senderName : null,
    })
    if ("error" in groupResult) return "error"
    groupId = groupResult.group.id
    groupCache.set(m.remoteDigits, groupId)
  }

  const { data: inserted, error } = await supabaseAdmin.rpc("wabridge_ingest_message", {
    p_group_id: groupId,
    p_channel_id: channelId,
    p_external_id: m.externalId,
    p_direction: m.direction,
    p_sender_phone: m.direction === "inbound" ? `+${m.remoteDigits}` : null,
    p_sender_name: m.senderName,
    p_content_type: m.contentType,
    p_content_text: m.contentText,
    p_created_at: m.createdAt,
    p_metadata: m.metadata as Json,
    p_backfill: backfill,
  })
  if (error) return "error"
  return inserted ? "inserted" : "deduped"
}
