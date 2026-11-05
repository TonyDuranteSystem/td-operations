/**
 * MCP tool team_chat_send — attaching My files › "From Claude" files (dev job f34c915d). Only the owner may name a My files file; copies are made
 * BEFORE the post and removed again when the post does not happen; ready links keep working for any staff session as before.
 */
import { describe, it, expect, beforeEach, vi } from "vitest"

vi.mock("@/lib/supabase-admin", () => ({ supabaseAdmin: {} }))
// the tool file also imports the read-side helpers (server-only modules) — not used by team_chat_send
vi.mock("@/lib/team/groups", () => ({ assertThreadAccess: vi.fn() }))
vi.mock("@/lib/team/thread-title", () => ({ resolveThreadTitle: vi.fn() }))
vi.mock("@/lib/auth-admin-helpers", () => ({ listAllAuthUsers: vi.fn(), findAuthUserByEmail: vi.fn() }))

const postTeamMessage = vi.fn()
vi.mock("@/lib/team/post-message", () => ({ postTeamMessage: (...a: unknown[]) => postTeamMessage(...a) }))
const attachMyFilesToChat = vi.fn()
const removeChatCopies = vi.fn()
vi.mock("@/lib/team/attach-from-my-files", () => ({
  attachMyFilesToChat: (...a: unknown[]) => attachMyFilesToChat(...a),
  removeChatCopies: (...a: unknown[]) => removeChatCopies(...a),
}))

import { runWithMcpAuthContext } from "@/lib/mcp/auth-context"
import { registerTeamChatTools } from "@/lib/mcp/tools/team-chat"

type Handler = (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>
function sendTool(): Handler {
  const tools: Record<string, Handler> = {}
  registerTeamChatTools({ tool: (name: string, _d: string, _s: unknown, h: Handler) => { tools[name] = h } } as never)
  return tools.team_chat_send
}

const OWNER = { method: "static" as const, email: "antonio.durante@tonydurante.us" }
const LUCA = { method: "oauth" as const, email: "luca@tonydurante.us" }
const ID_A = "0f8fad5b-d9cb-469f-a165-70867728950e"
const LINK = { url: "https://ydzipybqeebtpcvsbtvs.supabase.co/storage/v1/object/public/assets/x.pdf", name: "x.pdf" }
const COPY = { url: "https://ydzipybqeebtpcvsbtvs.supabase.co/storage/v1/object/public/assets/team-chat/claude/abc.pdf", name: "mockup.pdf", mime_type: "application/pdf", size: 574673 }
const posted = { thread_type: "group", thread_id: "t1", root_id: null, message_id: "m1", mentioned_user_ids: [] }

beforeEach(() => {
  vi.clearAllMocks()
  postTeamMessage.mockResolvedValue(posted)
  attachMyFilesToChat.mockResolvedValue({ ok: true, attachments: [COPY], paths: ["team-chat/claude/abc.pdf"] })
})

describe("team_chat_send with a My files file", () => {
  it("the owner: the file is copied first, then posted together with any ready links", async () => {
    const r = await runWithMcpAuthContext(OWNER, () => sendTool()({ thread_id: "t1", message: "hi", attachments: [LINK, { my_files_file_id: ID_A }] }))
    expect(r.content[0].text).toMatch(/✅ Posted/)
    expect(attachMyFilesToChat).toHaveBeenCalledWith([ID_A], { method: "static", email: OWNER.email })
    expect(postTeamMessage.mock.calls[0][0].attachments).toEqual([LINK, COPY])
    expect(removeChatCopies).not.toHaveBeenCalled()
  })

  it("anyone else is refused BEFORE anything is read, copied or posted", async () => {
    for (const ctx of [LUCA, { method: "oauth" as const, email: null }, { method: "static" as const, email: "support@tonydurante.us" }]) {
      const r = await runWithMcpAuthContext(ctx, () => sendTool()({ thread_id: "t1", message: "hi", attachments: [{ my_files_file_id: ID_A }] }))
      expect(r.content[0].text, JSON.stringify(ctx)).toMatch(/only works for a session signed in as the owner/)
    }
    expect(attachMyFilesToChat).not.toHaveBeenCalled()
    expect(postTeamMessage).not.toHaveBeenCalled()
  })

  it("no auth context at all is refused too", async () => {
    const r = await sendTool()({ thread_id: "t1", message: "hi", attachments: [{ my_files_file_id: ID_A }] })
    expect(r.content[0].text).toMatch(/only works for a session signed in as the owner/)
    expect(postTeamMessage).not.toHaveBeenCalled()
  })

  it("a refusal from the copy step is shown and nothing is posted", async () => {
    attachMyFilesToChat.mockResolvedValue({ ok: false, error: "\"a.pdf\" is not inside the \"From Claude\" folder." })
    const r = await runWithMcpAuthContext(OWNER, () => sendTool()({ thread_id: "t1", message: "hi", attachments: [{ my_files_file_id: ID_A }] }))
    expect(r.content[0].text).toBe("❌ Could not post to team chat: \"a.pdf\" is not inside the \"From Claude\" folder.")
    expect(postTeamMessage).not.toHaveBeenCalled()
  })

  it("if the post itself fails, the copies made for it are removed", async () => {
    postTeamMessage.mockRejectedValue(new Error("Target thread not found"))
    const r = await runWithMcpAuthContext(OWNER, () => sendTool()({ thread_id: "t1", message: "hi", attachments: [{ my_files_file_id: ID_A }] }))
    expect(r.content[0].text).toMatch(/Target thread not found/)
    expect(removeChatCopies).toHaveBeenCalledWith(["team-chat/claude/abc.pdf"])
  })
})

describe("team_chat_send with ready links only (unchanged)", () => {
  it("any staff session may attach a link already on our storage — no copy, no owner check", async () => {
    const r = await runWithMcpAuthContext(LUCA, () => sendTool()({ thread_id: "t1", message: "hi", attachments: [LINK] }))
    expect(r.content[0].text).toMatch(/✅ Posted/)
    expect(attachMyFilesToChat).not.toHaveBeenCalled()
    expect(postTeamMessage.mock.calls[0][0].attachments).toEqual([LINK])
  })

  it("no attachments at all posts exactly as before", async () => {
    await runWithMcpAuthContext(OWNER, () => sendTool()({ channel: "td-bug", message: "hi" }))
    expect(postTeamMessage.mock.calls[0][0].attachments).toBeUndefined()
  })
})

describe("bad attachment slots are refused before any copy", () => {
  it.each([
    ["both sources", [{ ...LINK, my_files_file_id: ID_A }], /EITHER a url OR a my_files_file_id/],
    ["neither source", [{ name: "x.pdf" }], /needs a url or a my_files_file_id/],
    ["a url with no name", [{ url: LINK.url }], /needs a name/],
    ["six attachments", Array.from({ length: 6 }, (_, i) => ({ ...LINK, name: `f${i}.pdf` })), /At most 5/],
    ["the same file twice", [{ my_files_file_id: ID_A }, { my_files_file_id: ID_A }], /twice/],
  ])("%s", async (_n, attachments, re) => {
    const r = await runWithMcpAuthContext(OWNER, () => sendTool()({ thread_id: "t1", message: "hi", attachments }))
    expect(r.content[0].text).toMatch(re)
    expect(attachMyFilesToChat).not.toHaveBeenCalled()
    expect(postTeamMessage).not.toHaveBeenCalled()
  })
})
