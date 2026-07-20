/**
 * Hermes ↔ Claude bridge — WP3: server Telegram push on propose.
 *
 * Pins the contract of sendTelegramApprovalNotification:
 *   - posts the formatted proposal to the Telegram Bot API when configured
 *   - skips cleanly (no fetch) when the token/chat env vars are missing
 *   - never throws on a network error or a non-2xx response (best-effort)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { sendTelegramApprovalNotification } from "@/lib/ai-agent/telegram-notify"

const ORIGINAL_ENV = { ...process.env }

const ROW = {
  id: "abcdef12-0000-0000-0000-000000000000",
  tool_name: "update_account_notes",
  params: { account_id: "a1111111-2222-4333-8444-555555555555", note: "Call the client" },
  rationale: "follow-up needed",
  confirmation_code: "123456",
}

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV }
  vi.restoreAllMocks()
})

afterEach(() => {
  process.env = { ...ORIGINAL_ENV }
})

describe("sendTelegramApprovalNotification (WP3)", () => {
  it("posts the formatted proposal to the Telegram Bot API when configured", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "BOT:TOKEN"
    process.env.TELEGRAM_APPROVAL_CHAT_ID = "307359927"
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200 }) as unknown as Response)
    vi.stubGlobal("fetch", fetchMock)

    const ok = await sendTelegramApprovalNotification(ROW)
    expect(ok).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe("https://api.telegram.org/botBOT:TOKEN/sendMessage")
    expect(init.method).toBe("POST")
    const body = JSON.parse(init.body as string)
    expect(body.chat_id).toBe("307359927")
    // The formatted proposal carries the tool label + the confirmation-code grammar.
    expect(body.text).toContain("Append note to account")
    expect(body.text).toContain("🔑 Code: 123456")
    expect(body.text).toContain("APPROVE abcdef12 123456")
  })

  it("skips (no fetch) and returns false when the token is missing", async () => {
    delete process.env.TELEGRAM_BOT_TOKEN
    process.env.TELEGRAM_APPROVAL_CHAT_ID = "307359927"
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200 }) as unknown as Response)
    vi.stubGlobal("fetch", fetchMock)

    const ok = await sendTelegramApprovalNotification(ROW)
    expect(ok).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("skips when the chat id is missing", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "BOT:TOKEN"
    delete process.env.TELEGRAM_APPROVAL_CHAT_ID
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200 }) as unknown as Response)
    vi.stubGlobal("fetch", fetchMock)

    expect(await sendTelegramApprovalNotification(ROW)).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("returns false (never throws) on a network error", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "BOT:TOKEN"
    process.env.TELEGRAM_APPROVAL_CHAT_ID = "307359927"
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network down") }))

    await expect(sendTelegramApprovalNotification(ROW)).resolves.toBe(false)
  })

  it("returns false on a non-2xx Telegram response", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "BOT:TOKEN"
    process.env.TELEGRAM_APPROVAL_CHAT_ID = "307359927"
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 403 }) as unknown as Response))

    expect(await sendTelegramApprovalNotification(ROW)).toBe(false)
  })
})
