/**
 * Slack interactive components webhook — Claude bot (app A0B9LUJRLMB)
 *
 * Handles:
 *  - "⏹ Stop" button (block_actions, action_id=stop_thinking) — cancels the
 *    in-flight agent_messages row (unchanged behavior).
 *  - Client-conversation form (Phase 2, dev_task 54f89912):
 *      • block_actions  / open_client_conversation  → opens the modal (views.open)
 *      • block_suggestion / client_select           → live CRM client search (options)
 *      • view_submission / client_conversation_modal → starts a labeled, tagged thread
 *
 * Slack delivers interactivity payloads as application/x-www-form-urlencoded with a
 * single `payload` JSON field. Signature verification is identical to the events
 * webhook (HMAC-SHA256, SLACK_SIGNING_SECRET_CLAUDE).
 *
 * Setup: in the Slack app's "Interactivity & Shortcuts": Request URL → this route
 * (already set; the Stop button proves it). For the live client dropdown, set the
 * "Select menus" Options Load URL → this same route. See slack-claude-worker.md.
 *
 * Public path (/api/webhooks/*) — auth-exempt in middleware, blocked in sandbox by
 * SANDBOX_MODE. Production-only, like the rest of slack-claude.
 */

export const dynamic = "force-dynamic"

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { listEntries } from "@/lib/catalog/framework"
import {
  verifySlackSignature,
  parseSlackInteractionFull,
  updateSlackMessage,
  openSlackModal,
  buildClientConversationModalView,
  searchClientsForSlackOptions,
  createClientConversationFromModal,
  STOP_THINKING_ACTION_ID,
  OPEN_CLIENT_CONVERSATION_ACTION_ID,
  CLIENT_CONVERSATION_MODAL_CALLBACK,
  CLIENT_SELECT_ACTION_ID,
  TOPIC_SELECT_ACTION_ID,
} from "@/lib/ai-agent/slack-claude"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function selectedValue(viewState: any, blockId: string, actionId: string): string | null {
  const sel = viewState?.values?.[blockId]?.[actionId]?.selected_option
  return (sel?.value as string | undefined) ?? null
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const rawBody = await req.text()
  const timestamp = req.headers.get("x-slack-request-timestamp") ?? ""
  const signature = req.headers.get("x-slack-signature") ?? ""

  if (!verifySlackSignature(rawBody, timestamp, signature, process.env.SLACK_SIGNING_SECRET_CLAUDE)) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 })
  }

  const it = parseSlackInteractionFull(rawBody)
  if (!it) return NextResponse.json({ ok: true })

  // ── Live client search for the modal's external_select ─────────────────────
  if (it.type === "block_suggestion" && it.actionId === CLIENT_SELECT_ACTION_ID) {
    const options = await searchClientsForSlackOptions(it.suggestionValue ?? "")
    return NextResponse.json({ options })
  }

  // ── Modal submit → start the labeled, tagged thread ────────────────────────
  if (it.type === "view_submission" && it.viewCallbackId === CLIENT_CONVERSATION_MODAL_CALLBACK) {
    const channelId = it.viewPrivateMetadata
    const clientValue = selectedValue(it.viewState, "client_block", CLIENT_SELECT_ACTION_ID)
    const topicSlug = selectedValue(it.viewState, "topic_block", TOPIC_SELECT_ACTION_ID)
    if (!channelId || !clientValue || !topicSlug) {
      return NextResponse.json({
        response_action: "errors",
        errors: { client_block: "Pick a client and a topic to start." },
      })
    }
    const res = await createClientConversationFromModal({
      channelId,
      userId: it.userId,
      clientValue,
      topicSlug,
    })
    if (!res.ok) {
      return NextResponse.json({
        response_action: "errors",
        errors: { client_block: res.error ?? "Could not start the conversation — try again." },
      })
    }
    // Empty 200 closes the modal cleanly.
    return NextResponse.json({})
  }

  // ── Button: open the client-conversation modal ─────────────────────────────
  if (it.type === "block_actions" && it.actionId === OPEN_CLIENT_CONVERSATION_ACTION_ID) {
    if (!it.triggerId || !it.channelId) return NextResponse.json({ ok: true })
    let topicOptions: Array<{ slug: string; label: string }> = []
    try {
      const entries = await listEntries("topic_templates", { status: "active" })
      topicOptions = entries
        .map((e) => ({ slug: e.slug, label: e.display_name }))
        .sort((a, b) => a.label.localeCompare(b.label))
    } catch {
      topicOptions = []
    }
    await openSlackModal(it.triggerId, buildClientConversationModalView({ channelId: it.channelId, topicOptions }))
    return NextResponse.json({ ok: true })
  }

  // ── "⏹ Stop" button (unchanged) ────────────────────────────────────────────
  if (it.type === "block_actions" && it.actionId === STOP_THINKING_ACTION_ID) {
    const { messageTs, channelId } = it
    if (!messageTs || !channelId) return NextResponse.json({ ok: true })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: cancelled, error } = await (supabaseAdmin as any)
      .from("agent_messages")
      .update({ status: "cancelled", updated_at: new Date().toISOString() })
      .eq("recipient", "claude")
      .filter("context_json->>slack_ack_ts", "eq", messageTs)
      .filter("context_json->>slack_channel_id", "eq", channelId)
      .in("status", ["pending", "processing"])
      .select("id")

    if (error) {
      console.error("[slack-interactions] cancel update failed:", error)
      return NextResponse.json({ ok: true })
    }

    if (cancelled?.length) {
      await updateSlackMessage(channelId, messageTs, "⏹ Stopped — go ahead with your update", []).catch(
        (err) => {
          console.error("[slack-interactions] stop message update failed:", err)
          return false
        },
      )
    }
    return NextResponse.json({ ok: true })
  }

  // ACK any unrelated/unknown interaction so Slack doesn't surface an error.
  return NextResponse.json({ ok: true })
}
