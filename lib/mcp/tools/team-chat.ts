import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { postTeamMessage } from "@/lib/team/post-message"

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

⚠️ MANDATORY — approval before sending (same rule as gmail_send): SHOW THE FULL DRAFT (target + exact message) in chat and WAIT for Antonio's explicit approval ("send it" / "go") before calling this tool. A general "tell Luca about X" is NOT approval — show the draft first. Never call this on the first turn that proposes the message.`,
    {
      channel: z.string().optional().describe('Channel slug or name (e.g. "td-dev", "general"). Provide exactly one target.'),
      thread_id: z.string().uuid().optional().describe("Existing team thread UUID. Provide exactly one target."),
      dm_user_id: z.string().uuid().optional().describe("Staff user UUID to DM as Claude. Provide exactly one target."),
      message: z.string().describe('Message body. @mention staff (e.g. "@Luca") to push them.'),
    },
    async ({ channel, thread_id, dm_user_id, message }) => {
      try {
        const result = await postTeamMessage({ channel, thread_id, dm_user_id, message })
        const who = result.mentioned_user_ids.length
          ? ` (pushed ${result.mentioned_user_ids.length} mentioned teammate${result.mentioned_user_ids.length > 1 ? "s" : ""})`
          : ""
        return {
          content: [
            {
              type: "text" as const,
              text: `✅ Posted to team chat (${result.thread_type} thread ${result.thread_id}), message ${result.message_id}${who}.`,
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
}
