import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { postTeamMessage } from "@/lib/team/post-message"
import { parseThreadLink, parseMessageLink, formatThreadReadout, formatMessageReadout } from "@/lib/team/thread-readout"
import { resolveThreadTitle } from "@/lib/team/thread-title"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { listAllAuthUsers, findAuthUserByEmail } from "@/lib/auth-admin-helpers"
import { assertThreadAccess } from "@/lib/team/groups"
import { getMcpAuthContext } from "@/lib/mcp/auth-context"

const PRIVATE_DENIED = "❌ That is a private chat (a direct message or a group) and I could not confirm you are in it, so I will not read it."

/** A group or direct message is private to its people. Reads here use the service role, so check the caller is one of them; an unknown caller is refused (fails closed). Returns a refusal text, or null when allowed. */
async function refusePrivateChat(threadId: string): Promise<string | null> {
  const email = getMcpAuthContext()?.email?.trim()
  const user = email ? await findAuthUserByEmail(email) : null
  const access = await assertThreadAccess(threadId, user?.id ?? "")
  return access.allowed ? null : PRIVATE_DENIED
}

const attachmentSchema = z.object({
  url: z.string().describe("File URL — must already be hosted on our own Storage (e.g. from portal_chat_attach_file). An off-site URL is rejected."),
  name: z.string().describe("Display filename shown on the attachment chip."),
  mime_type: z.string().optional(),
  size: z.number().optional(),
})

/**
 * team_chat_send — post a message into the internal Team Workspace ("team chat")
 * AS Claude. Staff-only, never client-visible. Shares the same choke-point
 * (lib/team/post-message.ts) as the AI worker's team_chat_send tool.
 */
export function registerTeamChatTools(server: McpServer) {
  server.tool(
    "team_chat_send",
    `Post a message into the internal Team Workspace ("team chat") AS Claude. Staff-only (Antonio, Luca) — NEVER visible to clients.

Use for team coordination: announcing a fix/deploy, flagging something to check, asking a teammate to test. To notify a specific teammate, @mention them in the message (e.g. "@Luca ..." or "@Antonio ...") — mentioned staff get a targeted push.

Target — provide EXACTLY ONE:
- channel: a channel slug or name (e.g. "td-dev", "general") — the usual choice for announcements
- thread_id: an existing team thread UUID
- dm_user_id: a staff user UUID to direct-message

ANSWERING A SPECIFIC BUG — add root_id: the answer lands INSIDE that bug's own thread instead of as a new message in the channel, and the teammate's notification opens the bug. ALWAYS prefer this when replying about a bug someone already opened; a bare channel post detaches the answer from the bug it belongs to. Get the root id from team_chat_read_thread (the link Antonio pasted carries it). Cannot be combined with dm_user_id.

ATTACHING A FILE — pass attachments (same shape as portal_chat_send). Every url must already be hosted on our own Storage — an arbitrary external link is rejected, and a plain link pasted into the message text does NOT render as a real attachment chip. To get a file onto our Storage first, use portal_chat_attach_file (source='drive'/'gmail'/'url'/'supabase_storage') — it returns a url safe to pass here even though its name says "portal".

⚠️ MANDATORY — approval before sending (same rule as gmail_send): SHOW THE FULL DRAFT (target + exact message) in chat and WAIT for Antonio's explicit approval ("send it" / "go") before calling this tool. A general "tell Luca about X" is NOT approval — show the draft first. Never call this on the first turn that proposes the message.`,
    {
      channel: z.string().optional().describe('Channel slug or name (e.g. "td-dev", "general"). Provide exactly one target.'),
      thread_id: z.string().uuid().optional().describe("Existing team thread UUID. Provide exactly one target."),
      dm_user_id: z.string().uuid().optional().describe("Staff user UUID to DM as Claude. Provide exactly one target."),
      root_id: z.string().uuid().optional().describe("Root message UUID of an existing thread — answer INSIDE that bug/topic rather than posting a new message into the channel. Must belong to the targeted channel."),
      message: z.string().describe('Message body. @mention staff (e.g. "@Luca") to push them.'),
      attachments: z.array(attachmentSchema).optional().describe("Real file attachments (rendered as chips, not text links). Every url must already be on our own Storage — see portal_chat_attach_file."),
    },
    async ({ channel, thread_id, dm_user_id, root_id, message, attachments }) => {
      try {
        // Who is dictating this send: the static Claude Code key maps to the
        // configured operator (Antonio); an OAuth connector session maps to its
        // own user; unknown maps to null = everyone notified (council rule —
        // see lib/mcp/auth-context.ts). The stamp silences ONLY that person's
        // push/toast/unread for their own dictated message.
        const { actingEmailForTeamChat } = await import("@/lib/mcp/auth-context")
        const result = await postTeamMessage({ channel, thread_id, dm_user_id, root_id, message, attachments, on_behalf_of: actingEmailForTeamChat() })
        const who = result.mentioned_user_ids.length
          ? ` (pushed ${result.mentioned_user_ids.length} mentioned teammate${result.mentioned_user_ids.length > 1 ? "s" : ""})`
          : ""
        return {
          content: [
            {
              type: "text" as const,
              text: `✅ Posted to team chat (${result.thread_type} thread ${result.thread_id})${result.root_id ? ` inside thread ${result.root_id}` : ""}, message ${result.message_id}${who}.`,
            },
          ],
        }
      } catch (e) {
        return {
          content: [{ type: "text" as const, text: `❌ Could not post to team chat: ${e instanceof Error ? e.message : String(e)}` }],
        }
      }
    },
  )

  server.tool(
    "team_chat_read_thread",
    `Read a Team Workspace ("team chat") thread by its link — staff-only, never client data.

Antonio copies a thread's link via "Copy link" in its ⋯ menu (Team Chat → any channel like td-bug/td-dev → a thread's actions menu) and pastes it here. This tool resolves that link straight to the channel + thread and returns its full content: title, status, assignee, and every message in order — so you don't need him to re-explain a bug or request that's already written up in Team Chat.

It also accepts a TD Talk MESSAGE link (…/td-talk?thread=<id>&message=<id>, from "Copy link" in a message's menu in TD Talk): it returns that message with a few around it, any attached files with their addresses, and voice-note text if one was made.

Give it the ENTIRE pasted link (e.g. https://crm.tonydurante.us/team-chat?thread=<id>&root=<id>) as-is — do not edit or shorten it. READ-ONLY.`,
    {
      link: z.string().describe('The full thread link copied from Team Chat\'s "Copy link" thread action.'),
    },
    async ({ link }) => {
      const msgLink = parseMessageLink(link)
      if (msgLink) {
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const sb = supabaseAdmin as any
          const { data: chat } = await sb.from("internal_threads").select("id, channel_name, channel_slug, thread_type, title").eq("id", msgLink.threadId).single()
          const { data: target } = await sb.from("internal_messages").select("id, created_at").eq("id", msgLink.messageId).eq("thread_id", msgLink.threadId).single()
          if (!chat || !target) return { content: [{ type: "text" as const, text: "❌ That chat or message no longer exists." }] }
          const refused = await refusePrivateChat(msgLink.threadId)
          if (refused) return { content: [{ type: "text" as const, text: refused }] }
          const cols = "id, message, sender_name, created_at, deleted_at, attachments"
          const [{ data: before }, { data: after }] = await Promise.all([
            sb.from("internal_messages").select(cols).eq("thread_id", msgLink.threadId).lte("created_at", target.created_at).order("created_at", { ascending: false }).limit(6),
            sb.from("internal_messages").select(cols).eq("thread_id", msgLink.threadId).gt("created_at", target.created_at).order("created_at", { ascending: true }).limit(3),
          ])
          const messages = [...((before ?? []) as any[]).reverse(), ...((after ?? []) as any[])] // eslint-disable-line @typescript-eslint/no-explicit-any
          const chatLabel = chat.thread_type === "dm" ? "direct message" : chat.channel_slug || chat.channel_name || chat.title || chat.thread_type
          return { content: [{ type: "text" as const, text: formatMessageReadout({ chatLabel, linkedId: msgLink.messageId, messages }) }] }
        } catch (e) {
          return { content: [{ type: "text" as const, text: `❌ Could not read that message: ${e instanceof Error ? e.message : String(e)}` }] }
        }
      }
      const parsed = parseThreadLink(link)
      if ("error" in parsed) {
        return { content: [{ type: "text" as const, text: `❌ ${parsed.error}` }] }
      }
      const { channelId, rootId } = parsed
      try {
        const refused = await refusePrivateChat(channelId)
        if (refused) return { content: [{ type: "text" as const, text: refused }] }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { data: channel } = await (supabaseAdmin as any)
          .from("internal_threads")
          .select("id, channel_name, channel_slug, thread_type")
          .eq("id", channelId)
          .single()
        if (!channel) {
          return { content: [{ type: "text" as const, text: "❌ That channel/thread no longer exists." }] }
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { data: root } = await (supabaseAdmin as any)
          .from("internal_messages")
          .select("id, message, sender_name, created_at, deleted_at, attachments")
          .eq("id", rootId)
          .eq("thread_id", channelId)
          .single()
        if (!root) {
          return { content: [{ type: "text" as const, text: "❌ That thread's opening message no longer exists in this channel." }] }
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { data: replies } = await (supabaseAdmin as any)
          .from("internal_messages")
          .select("id, message, sender_name, created_at, deleted_at, attachments")
          .eq("thread_id", channelId)
          .eq("root_id", rootId)
          .order("created_at", { ascending: true })

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { data: state } = await (supabaseAdmin as any)
          .from("internal_thread_state")
          .select("status, assignee_id, title")
          .eq("thread_id", channelId)
          .eq("root_message_id", rootId)
          .maybeSingle()

        let assigneeName: string | null = null
        if (state?.assignee_id) {
          const users = await listAllAuthUsers()
          const match = users.find(u => u.id === state.assignee_id)
          assigneeName = (match?.user_metadata?.full_name as string | undefined) || match?.email || null
        }

        const title = resolveThreadTitle({ stateTitle: state?.title, rootMessage: root.message, rootDeleted: !!root.deleted_at })
        const channelLabel = channel.channel_slug || channel.channel_name || "general"

        const text = formatThreadReadout({
          channelLabel,
          title,
          status: state?.status ?? "todo",
          assigneeName,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          messages: [root, ...((replies ?? []) as any[])],
          channelSlug: channel?.channel_slug ?? null,
          rootId,
        })

        return { content: [{ type: "text" as const, text }] }
      } catch (e) {
        return {
          content: [{ type: "text" as const, text: `❌ Could not read that thread: ${e instanceof Error ? e.message : String(e)}` }],
        }
      }
    },
  )
}
