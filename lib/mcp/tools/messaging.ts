/**
 * Messaging Tools — Unified WhatsApp/Telegram inbox via Supabase
 *
 * All messages live in Supabase (source of truth).
 * Periskope = bridge for WhatsApp, Telegram Bot API = bridge for Telegram.
 * These tools let Claude manage the inbox from any device.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { supabaseAdmin } from "@/lib/supabase-admin"

export function registerMessagingTools(server: McpServer) {

  // ═══════════════════════════════════════
  // msg_inbox — Overview of all messaging groups
  // ═══════════════════════════════════════
  server.tool(
    "msg_inbox",
    "Get messaging inbox overview: groups sorted by last message, with unread counts and last message preview. Filter by channel, unread status, or linked account.",
    {
      channel_id: z.string().uuid().optional().describe("Filter by messaging channel UUID"),
      unread_only: z.boolean().optional().default(false).describe("Only show groups with unread messages"),
      account_id: z.string().uuid().optional().describe("Filter by linked CRM account"),
      limit: z.number().optional().default(25).describe("Max results (default 25, max 100)"),
      offset: z.number().optional().default(0).describe("Offset for pagination"),
    },
    async ({ channel_id, unread_only, account_id, limit, offset }) => {
      try {
        let q = supabaseAdmin
          .from("v_messaging_inbox")
          .select("*")
          .order("last_message_at", { ascending: false, nullsFirst: false })
          .range(offset, offset + Math.min(limit, 100) - 1)

        if (channel_id) q = q.eq("channel_id", channel_id)
        if (unread_only) q = q.gt("unread_count", 0)
        if (account_id) q = q.eq("account_id", account_id)

        const { data, error } = await q

        if (error) throw error

        const summary = {
          total_groups: data?.length || 0,
          total_unread: data?.reduce((sum: number, g: any) => sum + (g.unread_count || 0), 0) || 0,
        }

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ summary, groups: data || [] }, null, 2),
          }],
        }
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `❌ msg_inbox error: ${err.message}` }] }
      }
    }
  )

  // ═══════════════════════════════════════
  // msg_read_group — Full thread for a group
  // ═══════════════════════════════════════
  server.tool(
    "msg_read_group",
    "Read the full message thread for a specific messaging group. Returns messages in chronological order with sender info.",
    {
      group_id: z.string().uuid().describe("Messaging group UUID"),
      limit: z.number().optional().default(50).describe("Max messages (default 50, max 200)"),
      before: z.string().optional().describe("ISO timestamp — get messages before this time (for pagination)"),
    },
    async ({ group_id, limit, before }) => {
      try {
        let q = supabaseAdmin
          .from("messages")
          .select("id, direction, sender_phone, sender_name, content_text, message_type, status, created_at, metadata")
          .eq("group_id", group_id)
          .order("created_at", { ascending: true })
          .limit(Math.min(limit, 200))

        if (before) q = q.lt("created_at", before)

        const { data, error } = await q

        if (error) throw error

        // Also get group info
        const { data: group } = await supabaseAdmin
          .from("messaging_groups")
          .select("id, group_name, external_group_id, channel_id, account_id, contact_id, unread_count, participant_count")
          .eq("id", group_id)
          .single()

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              group: group || { id: group_id },
              message_count: data?.length || 0,
              messages: data || [],
            }, null, 2),
          }],
        }
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `❌ msg_read_group error: ${err.message}` }] }
      }
    }
  )

  // ═══════════════════════════════════════
  // msg_search — Full-text search in messages
  // ═══════════════════════════════════════
  server.tool(
    "msg_search",
    "Search messages by text content, sender phone, or sender name. Returns matching messages with group context.",
    {
      text: z.string().optional().describe("Search in message content (case-insensitive)"),
      sender_phone: z.string().optional().describe("Filter by sender phone number (partial match)"),
      direction: z.enum(["inbound", "outbound"]).optional().describe("Filter by direction"),
      status: z.string().optional().describe("Filter by status (new, read, responded, archived)"),
      channel_id: z.string().uuid().optional().describe("Filter by channel"),
      limit: z.number().optional().default(25).describe("Max results"),
    },
    async ({ text, sender_phone, direction, status, channel_id, limit }) => {
      try {
        let q = supabaseAdmin
          .from("messages")
          .select("id, group_id, direction, sender_phone, sender_name, content_text, message_type, status, created_at, channel_id")
          .order("created_at", { ascending: false })
          .limit(Math.min(limit || 25, 100))

        if (text) q = q.ilike("content_text", `%${text}%`)
        if (sender_phone) q = q.ilike("sender_phone", `%${sender_phone}%`)
        if (direction) q = q.eq("direction", direction)
        if (status) q = q.eq("status", status)
        if (channel_id) q = q.eq("channel_id", channel_id)

        const { data, error } = await q

        if (error) throw error

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ results: data?.length || 0, messages: data || [] }, null, 2),
          }],
        }
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `❌ msg_search error: ${err.message}` }] }
      }
    }
  )

  // ═══════════════════════════════════════
  // msg_send — Send a message via Edge Function
  // ═══════════════════════════════════════
  server.tool(
    "msg_send",
    "Send a message to a WhatsApp chat/group via the send-message Edge Function. Requires the external chat_id (e.g. 393480610794@c.us) and the message text.",
    {
      chat_id: z.string().describe("External chat ID (e.g. 393480610794@c.us for WhatsApp)"),
      message: z.string().describe("Message text to send"),
      channel_id: z.string().uuid().optional().describe("Channel UUID (defaults to WhatsApp Lead channel)"),
    },
    async ({ chat_id, message, channel_id }) => {
      try {
        // Call the send-message Edge Function
        const efUrl = `${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/send-message`

        const response = await fetch(efUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
          },
          body: JSON.stringify({ chat_id, message, channel_id }),
        })

        const result = await response.json()

        if (!response.ok) {
          return {
            content: [{
              type: "text" as const,
              text: `❌ Send failed (${response.status}): ${JSON.stringify(result)}`,
            }],
          }
        }

        return {
          content: [{
            type: "text" as const,
            text: `✅ Message sent to ${chat_id}\n${JSON.stringify(result, null, 2)}`,
          }],
        }
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `❌ msg_send error: ${err.message}` }] }
      }
    }
  )

  // ═══════════════════════════════════════
  // msg_mark_read — Update message status
  // ═══════════════════════════════════════
  server.tool(
    "msg_mark_read",
    "Mark messages as read (or other status). Can mark a single message, all messages in a group, or all new messages.",
    {
      message_id: z.string().uuid().optional().describe("Single message UUID to update"),
      group_id: z.string().uuid().optional().describe("Mark all new messages in this group as read"),
      new_status: z.enum(["read", "responded", "archived"]).optional().default("read").describe("New status to set"),
    },
    async ({ message_id, group_id, new_status }) => {
      try {
        let count = 0

        if (message_id) {
          const { error } = await supabaseAdmin
            .from("messages")
            .update({ status: new_status })
            .eq("id", message_id)
          if (error) throw error
          count = 1
        } else if (group_id) {
          const { data, error } = await supabaseAdmin
            .from("messages")
            .update({ status: new_status })
            .eq("group_id", group_id)
            .eq("status", "new")
            .eq("direction", "inbound")
            .select("id")
          if (error) throw error
          count = data?.length || 0
        } else {
          return { content: [{ type: "text" as const, text: "❌ Provide message_id or group_id" }] }
        }

        return {
          content: [{
            type: "text" as const,
            text: `✅ ${count} message(s) marked as ${new_status}`,
          }],
        }
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `❌ msg_mark_read error: ${err.message}` }] }
      }
    }
  )

  // ═══════════════════════════════════════
  // msg_list_channels — List messaging channels
  // ═══════════════════════════════════════
  server.tool(
    "msg_list_channels",
    "List all messaging channels (WhatsApp numbers, Telegram bots) with their status and group counts.",
    {},
    async () => {
      try {
        const { data: channels, error } = await supabaseAdmin
          .from("messaging_channels")
          .select("id, channel_name, phone_number, provider, is_active, config_json, created_at")
          .order("channel_name")

        if (error) throw error

        // Get group counts per channel
        const { data: groupCounts } = await supabaseAdmin
          .rpc("exec_sql", {
            sql_query: "SELECT channel_id, COUNT(*) as group_count, SUM(unread_count) as total_unread FROM messaging_groups GROUP BY channel_id",
          })

        const countsMap = new Map(
          (Array.isArray(groupCounts) ? groupCounts : []).map((r: any) => [r.channel_id, r])
        )

        const enriched = (channels || []).map((ch: any) => ({
          ...ch,
          group_count: countsMap.get(ch.id)?.group_count || 0,
          total_unread: countsMap.get(ch.id)?.total_unread || 0,
        }))

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify(enriched, null, 2),
          }],
        }
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `❌ msg_list_channels error: ${err.message}` }] }
      }
    }
  )
}
