/**
 * MCP tool team_chat_send — attaching My files › "From Claude" files (dev job f34c915d). Only the owner may name a My files file; the copy is
 * made by postTeamMessage ONLY once the target, message and links are known good (the `late_attachments` hook), and is removed again when the
 * post does not happen; ready links keep working for any staff session as before.
 */
import { describe, it, expect, beforeEach, vi } from "vitest"

vi.mock("@/lib/supabase-admin", () => ({ supabaseAdmin: {} }))
// the tool file also imports the read-side helpers (server-only modules) — not used by team_chat_send
vi.mock("@/lib/team/groups", () => ({ assertThreadAccess: vi.fn() }))
vi.mock("@/lib/team/thread-title", () => ({ resolveThreadTitle: vi.fn() }))
vi.mock("@/lib/auth-admin-helpers", () => ({ listAllAuthUsers: vi.fn(), findAuthUserByEmail: vi.fn() }))

// postTeamMessage is replaced by a stand-in that behaves like the real one where it matters here: it runs the late hook (if any) and
// can be told to fail either before the hook (bad target) or after it (insert error).
interface PostInput { attachments?: unknown[]; late_attachments?: (() => Promise<unknown[]>) | null }
let posted: unknown[] | undefined
let failBeforeHook: Error | null = null
let failAfterHook: Error | null = null
const postTeamMessage = vi.fn(async (input: PostInput) => {
  if (failBeforeHook) throw failBeforeHook
  const late = input.late_attachments ? await input.late_attachments() : []
  posted = [...(input.attachments ?? []), ...late]
  if (failAfterHook) throw failAfterHook
  return { thread_type: "group", thread_id: "t1", root_id: null, message_id: "m1", mentioned_user_ids: [] }
})
vi.mock("@/lib/team/post-message", () => ({ postTeamMessage: (...a: [PostInput]) => postTeamMessage(...a) }))
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

beforeEach(() => {
  vi.clearAllMocks()
  posted = undefined
  failBeforeHook = null
  failAfterHook = null
  attachMyFilesToChat.mockResolvedValue({ ok: true, attachments: [COPY], paths: ["team-chat/claude/abc.pdf"] })
  removeChatCopies.mockResolvedValue([])
})

describe("team_chat_send with a My files file", () => {
  it("the owner: the file is copied (inside the post) and posted together with any ready links", async () => {
    const r = await runWithMcpAuthContext(OWNER, () => sendTool()({ thread_id: "t1", message: "hi", attachments: [LINK, { my_files_file_id: ID_A }] }))
    expect(r.content[0].text).toMatch(/✅ Posted/)
    expect(attachMyFilesToChat).toHaveBeenCalledWith([ID_A], { method: "static", email: OWNER.email })
    expect(posted).toEqual([LINK, COPY])
    expect(removeChatCopies).not.toHaveBeenCalled()
  })

  it("the copy is NOT made by the tool itself: it is handed to the post as a hook, so a bad target never reaches it", async () => {
    failBeforeHook = new Error("Target thread not found (check the channel slug/name, thread id, or user id).")
    const r = await runWithMcpAuthContext(OWNER, () => sendTool()({ channel: "td_dev", message: "hi", attachments: [{ my_files_file_id: ID_A }] }))
    expect(r.content[0].text).toMatch(/Target thread not found/)
    expect(attachMyFilesToChat).not.toHaveBeenCalled() // nothing was read, copied or made public
    expect(removeChatCopies).toHaveBeenCalledWith([]) // nothing to remove
    expect(typeof postTeamMessage.mock.calls[0][0].late_attachments).toBe("function")
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

  it("a refusal from the copy step is shown exactly as before and nothing is posted", async () => {
    attachMyFilesToChat.mockResolvedValue({ ok: false, error: "\"a.pdf\" is not inside the \"From Claude\" folder." })
    const r = await runWithMcpAuthContext(OWNER, () => sendTool()({ thread_id: "t1", message: "hi", attachments: [{ my_files_file_id: ID_A }] }))
    expect(r.content[0].text).toBe("❌ Could not post to team chat: \"a.pdf\" is not inside the \"From Claude\" folder.")
    expect(posted).toBeUndefined()
  })

  it("if the post fails AFTER the copy, the copies made for it are removed", async () => {
    failAfterHook = new Error("insert failed")
    const r = await runWithMcpAuthContext(OWNER, () => sendTool()({ thread_id: "t1", message: "hi", attachments: [{ my_files_file_id: ID_A }] }))
    expect(r.content[0].text).toMatch(/insert failed/)
    expect(removeChatCopies).toHaveBeenCalledWith(["team-chat/claude/abc.pdf"])
    expect(r.content[0].text).not.toMatch(/could not be removed/)
  })

  it("if a copy cannot be removed either, the answer says so and names where it is (a public copy must not be silent)", async () => {
    failAfterHook = new Error("insert failed")
    removeChatCopies.mockResolvedValue(["team-chat/claude/abc.pdf"])
    const r = await runWithMcpAuthContext(OWNER, () => sendTool()({ thread_id: "t1", message: "hi", attachments: [{ my_files_file_id: ID_A }] }))
    expect(r.content[0].text).toMatch(/insert failed/)
    expect(r.content[0].text).toMatch(/A temporary copy could not be removed from chat storage \(team-chat\/claude\/abc\.pdf\)/)
  })
})

describe("team_chat_send with ready links only (unchanged)", () => {
  it("any staff session may attach a link already on our storage — no copy, no owner check, no hook", async () => {
    const r = await runWithMcpAuthContext(LUCA, () => sendTool()({ thread_id: "t1", message: "hi", attachments: [LINK] }))
    expect(r.content[0].text).toMatch(/✅ Posted/)
    expect(attachMyFilesToChat).not.toHaveBeenCalled()
    expect(posted).toEqual([LINK])
    expect(postTeamMessage.mock.calls[0][0].late_attachments).toBeUndefined()
  })

  it("no attachments at all posts exactly as before", async () => {
    await runWithMcpAuthContext(OWNER, () => sendTool()({ channel: "td-bug", message: "hi" }))
    expect(postTeamMessage.mock.calls[0][0].attachments).toBeUndefined()
    expect(postTeamMessage.mock.calls[0][0].late_attachments).toBeUndefined()
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
