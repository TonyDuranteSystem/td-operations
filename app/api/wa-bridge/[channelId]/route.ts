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
import { emitUiEvent } from "@/lib/ui-events"
import { isFreshInbound, inboundSignalPayload } from "@/lib/messaging/inbound-sound"
import { parseReactionsBatch, mergeReactionResults } from "@/lib/messaging/wabridge-reactions"
import { parseReactClaim, parseReactResult } from "@/lib/messaging/wabridge-react"
import { parseLinkCode } from "@/lib/messaging/wabridge-link"
import { parseSendClaim, parseSendResult } from "@/lib/messaging/wabridge-outbox"
import {
  inboundMediaPath,
  MAX_AUDIO_BYTES,
  MAX_MEDIA_BYTES,
  parseMediaClaim,
  parseMediaResult,
  parseMediaUploadUrlRequest,
  voicePath,
  VOICE_BUCKET,
} from "@/lib/messaging/wabridge-media"

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
 *  - {event:"bridge.reactions", ts, scan_ms, items:[{ext_id,chat,side,op,emoji?,reacted_at?}]}   reactions made on the phone → shown in the CRM (display only, sends nothing; answered PER ITEM)
 *  - {event:"bridge.send.claim", ts}                                  the Mac's sender asks for its NEXT reply (pacing + pause switch enforced in the database)
 *  - {event:"bridge.send.result", ts, outbox_id, ok, message_id?, error?}   what the Mac's WhatsApp program answered for that reply
 *  - {event:"bridge.react.claim", ts}                                the Mac's REACTION sender asks for its next due CRM→phone reaction (switch, allowlist, health, pacing, caps enforced in the database)
 *  - {event:"bridge.react.result", ts, id, attempt, ok, error?}       what the WhatsApp program answered for that reaction (attempt = the claim number it was given)
 *  - {event:"bridge.media.claim", ts}                                 the Mac asks for its NEXT voice note to fetch (answer carries a signed upload URL)
 *  - {event:"bridge.media.result", ts, message_id, outcome, size_bytes?, duration_seconds?, transcript?, language?, model?, error?}
 *  - {event:"bridge.linkcode", ts, code}                            a pairing code the Mac fetched while the device is unlinked (shown to the owner only)
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

  // ─── A pairing code from the Mac while the device is unlinked (Reconnect from the CRM) ───
  // The code is a credential-equivalent: never echoed in a response, never logged, refused when the device is logged in
  // or after the outage cap (wabridge_set_link_code).
  if (kind === "bridge.linkcode") {
    const lc = parseLinkCode(body, now)
    if (!lc) return NextResponse.json({ error: "bad linkcode" }, { status: 400 })
    if (lc.ok === false) return NextResponse.json({ error: lc.reason }, { status: 400 })
    const { data: stored, error: lcError } = await supabaseAdmin.rpc("wabridge_set_link_code", {
      p_channel_id: channel.id,
      p_code: lc.code,
    })
    if (lcError) return NextResponse.json({ error: "could not store code" }, { status: 500 })
    return NextResponse.json({ ok: true, stored: stored === true })
  }

  // ─── Reply sender (stage 2): the Mac claims ONE queued reply at a time, sends it through its own program, then reports ───
  // Every rule (paused / test mode, health, one in flight, ~1 minute gap, hourly + daily caps, distinct people, identical text, allowlist,
  // reply-only) is enforced INSIDE wabridge_claim_send. The reply text is only ever returned to a correctly SIGNED caller.
  if (kind === "bridge.send.claim") {
    const c = parseSendClaim(body, now)
    if (!c) return NextResponse.json({ error: "bad claim" }, { status: 400 })
    if (c.ok === false) return NextResponse.json({ error: c.reason }, { status: 400 })
    const { data: claimed, error: claimError } = await supabaseAdmin.rpc("wabridge_claim_send", {
      p_channel_id: channel.id,
      p_supports_kinds: c.supports,
    })
    if (claimError || typeof claimed !== "object" || claimed === null) {
      return NextResponse.json({ error: "could not claim" }, { status: 500 })
    }
    const item = claimed as Record<string, unknown>
    // A non-text claim needs the Mac to DOWNLOAD the file — mint a short-lived signed link to it (the bucket is
    // private). If minting fails, fail this claim explicitly right here rather than hand back a row with nothing
    // to download: the row stays 'unknown' otherwise and would sit stuck until a human resolves it.
    if (item.claimed === true && item.kind && item.kind !== "text" && typeof item.media_path === "string") {
      const { data: signed, error: signError } = await supabaseAdmin.storage.from(VOICE_BUCKET).createSignedUrl(item.media_path, 300)
      if (signError || !signed?.signedUrl) {
        await supabaseAdmin.rpc("wabridge_finish_send", {
          p_channel_id: channel.id,
          p_outbox_id: item.id as string,
          p_ok: false,
          p_message_id: null,
          p_error: "could not prepare the file for download",
        })
        return NextResponse.json({ ok: true, claimed: false, reason: "held" })
      }
      return NextResponse.json({ ok: true, ...item, media_url: signed.signedUrl })
    }
    return NextResponse.json({ ok: true, ...item })
  }

  if (kind === "bridge.send.result") {
    const r = parseSendResult(body, now)
    if (!r) return NextResponse.json({ error: "bad result" }, { status: 400 })
    if (r.ok === false) return NextResponse.json({ error: r.reason }, { status: 400 })
    const { data: finished, error: finishError } = await supabaseAdmin.rpc("wabridge_finish_send", {
      p_channel_id: channel.id,
      p_outbox_id: r.outboxId,
      p_ok: r.sent,
      p_message_id: r.messageId,
      p_error: r.error,
    })
    if (finishError || typeof finished !== "object" || finished === null) {
      return NextResponse.json({ error: "could not record the result" }, { status: 500 })
    }
    await emitUiEvent("whatsapp") // the reply's status (sent / failed) changed — open Inboxes refresh at once
    return NextResponse.json(finished)
  }

  // ─── CRM → phone reactions: the Mac's SEPARATE reaction sender (react.mjs) asks for the next DUE reaction and reports its result ───
  // Every rule (switch, allowlist, health, reader alive, pacing, caps, 10 s hold, expiry) is enforced INSIDE wabridge_claim_reaction;
  // {claimed:false, reason} is a normal 200 — the Mac just waits. A reaction is idempotent on WhatsApp, so no "unknown" state exists.
  if (kind === "bridge.react.claim") {
    const c = parseReactClaim(body, now)
    if (!c) return NextResponse.json({ error: "bad claim" }, { status: 400 })
    if (c.ok === false) return NextResponse.json({ error: c.reason }, { status: 400 })
    const { data: claimed, error: claimError } = await supabaseAdmin.rpc("wabridge_claim_reaction", { p_channel_id: channel.id })
    if (claimError || typeof claimed !== "object" || claimed === null) return NextResponse.json({ error: "could not claim" }, { status: 500 })
    return NextResponse.json({ ok: true, ...(claimed as Record<string, unknown>) })
  }

  if (kind === "bridge.react.result") {
    const r = parseReactResult(body, now)
    if (!r) return NextResponse.json({ error: "bad result" }, { status: 400 })
    if (r.ok === false) return NextResponse.json({ error: r.reason }, { status: 400 })
    const { data: finished, error: finishError } = await supabaseAdmin.rpc("wabridge_finish_reaction", {
      p_channel_id: channel.id,
      p_id: r.id as string,
      p_ok: r.sent,
      p_error: r.error,
      p_attempt: r.attempt, // the claim number — an answer for an older claim is refused inside the function
      p_ts: r.ts, // the Mac's clock: the phone element's scan_ms (ONE clock, like the phone→CRM reader)
    })
    if (finishError || typeof finished !== "object" || finished === null) {
      return NextResponse.json({ error: "could not record the result" }, { status: 500 })
    }
    await emitUiEvent("whatsapp") // the pill turns "phone" (sent) or shows why not — open Inboxes refresh at once
    return NextResponse.json(finished)
  }

  // ─── Media (voice notes + inbound photos/videos/documents): the Mac claims ONE item, downloads/prepares it, ───
  // ─── uploads to a signed URL we mint, then reports. The storage path is built HERE (never chosen by the Mac). ───
  // Voice's path is fixed and known at claim time (upload URL minted immediately, unchanged since Phase 1). A
  // non-voice item's path depends on the mime the Mac discovers only after downloading — see bridge.media.upload_url.
  if (kind === "bridge.media.claim") {
    const c = parseMediaClaim(body, now)
    if (!c) return NextResponse.json({ error: "bad claim" }, { status: 400 })
    if (c.ok === false) return NextResponse.json({ error: c.reason }, { status: 400 })
    const { data: claimed, error: claimError } = await supabaseAdmin.rpc("wabridge_media_claim", { p_channel_id: channel.id })
    if (claimError || typeof claimed !== "object" || claimed === null) {
      return NextResponse.json({ error: "could not claim" }, { status: 500 })
    }
    const item = claimed as Record<string, unknown>
    if (item.claimed !== true) return NextResponse.json({ ok: true, ...item })
    const path = typeof item.path === "string" ? item.path : ""
    if (!path) {
      // non-voice: no path yet — the Mac must call bridge.media.upload_url once it knows the real mime.
      return NextResponse.json({ ok: true, ...item })
    }
    const { data: signed, error: signError } = await supabaseAdmin.storage.from(VOICE_BUCKET).createSignedUploadUrl(path, { upsert: true })
    if (signError || !signed?.signedUrl) return NextResponse.json({ error: "could not prepare the upload" }, { status: 500 })
    return NextResponse.json({ ok: true, ...item, upload_url: signed.signedUrl })
  }

  // ─── Non-voice only: the Mac has downloaded the file and learned its real mime; mint the (now-computable) upload URL. ───
  if (kind === "bridge.media.upload_url") {
    const u = parseMediaUploadUrlRequest(body, now)
    if (!u) return NextResponse.json({ error: "bad request" }, { status: 400 })
    if (u.ok === false) return NextResponse.json({ error: u.reason }, { status: 400 })
    const { data: media, error: mediaError } = await supabaseAdmin
      .from("message_media")
      .select("kind, status")
      .eq("message_id", u.messageId)
      .eq("channel_id", channel.id)
      .maybeSingle()
    if (mediaError) return NextResponse.json({ error: "could not look up this item" }, { status: 500 })
    if (!media || media.status !== "processing" || media.kind === "voice") {
      return NextResponse.json({ error: "not a claimed non-voice item" }, { status: 409 })
    }
    const path = inboundMediaPath(channel.id, u.messageId, u.mime)
    const { data: signed, error: signError } = await supabaseAdmin.storage.from(VOICE_BUCKET).createSignedUploadUrl(path, { upsert: true })
    if (signError || !signed?.signedUrl) return NextResponse.json({ error: "could not prepare the upload" }, { status: 500 })
    return NextResponse.json({ ok: true, path, upload_url: signed.signedUrl })
  }

  if (kind === "bridge.media.result") {
    // The size ceiling depends on the kind — look it up before parsing (voice keeps its existing 25 MB cap).
    const bodyMessageId = typeof (body as Record<string, unknown> | null)?.message_id === "string" ? (body as Record<string, unknown>).message_id as string : null
    let resultKind: string | null = null
    if (bodyMessageId && UUID_RE.test(bodyMessageId)) {
      const { data: mediaRow } = await supabaseAdmin.from("message_media").select("kind").eq("message_id", bodyMessageId).eq("channel_id", channel.id).maybeSingle()
      resultKind = mediaRow?.kind ?? null
    }
    const isVoice = resultKind !== "image" && resultKind !== "video" && resultKind !== "document"
    const r = parseMediaResult(body, now, isVoice ? MAX_AUDIO_BYTES : MAX_MEDIA_BYTES)
    if (!r) return NextResponse.json({ error: "bad result" }, { status: 400 })
    if (r.ok === false) return NextResponse.json({ error: r.reason }, { status: 400 })
    const path = isVoice ? voicePath(channel.id, r.messageId) : inboundMediaPath(channel.id, r.messageId, r.mime)
    const fileName = path.slice(path.lastIndexOf("/") + 1)
    if (r.outcome === "ready") {
      // Never mark ready on the Mac's word alone: the object must really be there.
      const folder = path.slice(0, path.lastIndexOf("/"))
      const { data: found, error: listError } = await supabaseAdmin.storage.from(VOICE_BUCKET).list(folder, { search: fileName, limit: 5 })
      if (listError) return NextResponse.json({ error: "could not verify the upload" }, { status: 500 })
      if (!found?.some((f) => f.name === fileName)) return NextResponse.json({ error: "file not found in storage" }, { status: 409 })
    }
    const { data: finished, error: finishError } = await supabaseAdmin.rpc("wabridge_media_finish", {
      p_channel_id: channel.id,
      p_message_id: r.messageId,
      p_outcome: r.outcome,
      p_path: r.outcome === "ready" ? path : null,
      p_mime: r.outcome === "ready" ? (isVoice ? "audio/mp4" : r.mime) : null,
      p_size: r.sizeBytes,
      p_duration: r.durationSeconds,
      p_transcript: r.transcript,
      p_language: r.language,
      p_model: r.model,
      p_error: r.error,
    })
    if (finishError || typeof finished !== "object" || finished === null) {
      return NextResponse.json({ error: "could not record the result" }, { status: 500 })
    }
    await emitUiEvent("whatsapp") // a voice note / photo became playable — open Inboxes refresh at once
    return NextResponse.json(finished)
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
    if (typeof updated === "number" && updated > 0) await emitUiEvent("whatsapp") // chat names changed in the list
    return NextResponse.json({ ok: true, updated: updated ?? 0 })
  }

  // ─── Reactions made ON THE PHONE (clients' and the business line's own), read by the Mac from GOWA's own records ───
  // Display only — nothing is ever sent to WhatsApp from here. The answer is PER ITEM (applied / noop / stale / held /
  // unmatched / invalid) so the Mac advances only on explicit results and one bad item never blocks the rest. Even an
  // EMPTY batch is a valid "I am alive and scanning" beat (the database records it).
  if (kind === "bridge.reactions") {
    const parsed = parseReactionsBatch(body, now)
    if (!parsed.ok) return NextResponse.json({ error: `Invalid reactions batch: ${parsed.reason}` }, { status: 400 })
    const validItems = parsed.entries.flatMap((e) => (e.valid && e.item ? [e.item] : []))
    const { data: applied, error: reactionsError } = await supabaseAdmin.rpc("wabridge_apply_observed_reactions", {
      p_channel_id: channel.id,
      p_items: validItems as unknown as Json,
      p_scan_ms: parsed.scanMs,
    })
    if (reactionsError) return NextResponse.json({ error: "could not apply reactions" }, { status: 500 })
    const a = applied as { ok?: boolean; code?: string; results?: Array<{ i: number; r: string }> } | null
    if (!a || a.ok !== true || !Array.isArray(a.results)) {
      return NextResponse.json({ error: `reactions refused${a?.code ? `: ${a.code}` : ""}` }, { status: 400 })
    }
    // Only a real change wakes the screens — the every-scan "alive" beat (empty batch) and no-op / stale / held answers do not.
    if (a.results.some((x) => x.r === "applied")) await emitUiEvent("whatsapp")
    const results = mergeReactionResults(parsed.entries, a.results)
    return NextResponse.json({ ok: true, results })
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
    let freshInbound = 0 // live catch-up only: NEW customer messages that should ring the CRM (never history, never our own)
    for (const raw of b.items) {
      const m = normalizeBackfillItem(raw, now)
      if (!m) {
        skipped++
        continue
      }
      const r = await ingest(channel.id, m, b.live !== true, groupCache)
      if (r === "error") {
        // Items saved before the failure are real — wake the screens now: the Mac's retry will see them as deduped (inserted=0) and never signal.
        if (b.live === true && inserted > 0) await emitUiEvent("whatsapp", inboundSignalPayload(freshInbound))
        return NextResponse.json({ error: "ingest failed" }, { status: 500 })
      }
      if (r === "inserted") {
        inserted++
        if (b.live === true && isFreshInbound(m.direction, m.createdAt, now)) freshInbound++
      } else deduped++
    }
    // One signal per batch, and only for the live catch-up — a history download must not make every open Inbox refetch.
    if (b.live === true && inserted > 0) await emitUiEvent("whatsapp", inboundSignalPayload(freshInbound))
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
  // a new message — open Inboxes refresh the list and the open chat within seconds; a fresh CUSTOMER message also rings (payload.inbound)
  if (r === "inserted") await emitUiEvent("whatsapp", inboundSignalPayload(isFreshInbound(parsed.message.direction, parsed.message.createdAt, now) ? 1 : 0))
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

    // A LIVE message for a chat that is not yet linked to a lead/contact/company: try to link it on the spot (exact number,
    // one person, names agree — rules in wabridge_link_chat). Never blocks or fails the save: the 1-minute sweep is the safety net.
    const g = groupResult.group
    if (!backfill && !g.lead_id && !g.contact_id && !g.account_id) {
      try {
        const { error: linkError } = await supabaseAdmin.rpc("wabridge_link_chat", { p_group_id: groupId })
        if (linkError) console.warn("[wa-bridge] auto-link failed (the 1-minute sweep will retry):", linkError.message)
      } catch (err) {
        console.warn("[wa-bridge] auto-link threw (the 1-minute sweep will retry):", err instanceof Error ? err.message : String(err))
      }
    }
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
