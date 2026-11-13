// A team chat message must give the client's alert time to leave before the server is allowed to stop (dev job 056a70d0, 13 Nov 2026).
// Real case: Antonio sent a chat message to the demo login; production logged "[client-app] phone ...: retry_later (connection)" 8 seconds later, under
// a different request, because the chat route started the alert and answered without waiting. These tests pin the three parts of the fix:
// createPortalNotification hands the alert back (`pushDone`), waitForClientAlert waits for it but never longer than the cap, and the five team-to-client
// chat senders use it.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const insertResult: { error: { message: string } | null } = { error: null }
vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: { from: () => ({ insert: () => Promise.resolve(insertResult) }) },
}))
const pushToContact = vi.fn()
const pushToAccount = vi.fn()
vi.mock("@/lib/portal/web-push", () => ({
  sendPushToContact: (...a: unknown[]) => pushToContact(...a),
  sendPushToAccount: (...a: unknown[]) => pushToAccount(...a),
}))

import { createPortalNotification, waitForClientAlert } from "@/lib/portal/notifications"
import { PHONE_WAIT_MS } from "@/lib/app/phone-leg"

describe("createPortalNotification hands back its alert", () => {
  beforeEach(() => { pushToContact.mockReset(); pushToAccount.mockReset() })

  it("returns before a slow alert finishes (existing callers are not slowed), and pushDone resolves when it does", async () => {
    let release: () => void = () => undefined
    pushToContact.mockReturnValue(new Promise<void>(r => { release = r }))
    const result = await createPortalNotification({ contact_id: "c", type: "chat", title: "x" })
    expect(result.error).toBeNull()
    let done = false
    void result.pushDone?.then(() => { done = true })
    await Promise.resolve()
    expect(done).toBe(false)
    release()
    await result.pushDone
    expect(done).toBe(true)
  })

  it("uses the company send when there is no contact, and pushDone never rejects when the alert fails", async () => {
    pushToAccount.mockRejectedValue(new Error("apple down"))
    const result = await createPortalNotification({ account_id: "a", type: "chat", title: "x" })
    expect(pushToAccount).toHaveBeenCalledTimes(1)
    expect(pushToContact).not.toHaveBeenCalled()
    await expect(result.pushDone).resolves.toBeUndefined()
  })
})

describe("waitForClientAlert", () => {
  beforeEach(() => { vi.useFakeTimers(); pushToContact.mockReset() })
  afterEach(() => { vi.useRealTimers() })

  it("waits for the alert to finish", async () => {
    let release: () => void = () => undefined
    pushToContact.mockReturnValue(new Promise<void>(r => { release = r }))
    let waited = false
    const w = waitForClientAlert(createPortalNotification({ contact_id: "c", type: "chat", title: "x" })).then(() => { waited = true })
    await vi.advanceTimersByTimeAsync(1000)
    expect(waited).toBe(false)
    release()
    await w
    expect(waited).toBe(true)
  })

  it("never waits longer than the cap when the alert hangs", async () => {
    pushToContact.mockReturnValue(new Promise<void>(() => undefined))
    let waited = false
    const w = waitForClientAlert(createPortalNotification({ contact_id: "c", type: "chat", title: "x" })).then(() => { waited = true })
    await vi.advanceTimersByTimeAsync(PHONE_WAIT_MS - 1)
    expect(waited).toBe(false)
    await vi.advanceTimersByTimeAsync(2)
    await w
    expect(waited).toBe(true)
  })

  it("never rejects (a failed notification, or none at all)", async () => {
    await expect(waitForClientAlert(Promise.reject(new Error("boom")))).resolves.toBeUndefined()
    await expect(waitForClientAlert(Promise.resolve(undefined))).resolves.toBeUndefined()
    await expect(waitForClientAlert(Promise.resolve({ error: "x" } as { pushDone?: Promise<unknown> }))).resolves.toBeUndefined()
  })
})

describe("the five team-to-client chat senders wait for the alert", () => {
  const read = (p: string) => readFileSync(join(__dirname, "..", "..", p), "utf8")
  const senders = [
    "app/api/portal/chat/route.ts",
    "app/api/flows/[id]/chat/route.ts",
    "app/api/onboarding-review/[id]/chat/route.ts",
    "lib/mcp/tools/portal.ts",
    "lib/ai-agent/worker-tools.ts",
  ]
  for (const file of senders) {
    it(`${file}: keeps the alert and waits for it`, () => {
      const src = read(file)
      expect(src).toContain("waitForClientAlert")
      // the alert is kept in a variable and awaited, never started and dropped
      expect(src).toMatch(/const clientAlert = createPortalNotification\(/)
      expect(src).toMatch(/await waitForClientAlert\(clientAlert\)/)
      // and the old detached form is gone for the chat alert
      expect(src).not.toMatch(/type: ['"]chat['"],\s*title: ['"]New message from Tony Durante Team['"][\s\S]{0,300}?\}\)\.catch\(\(\) => \{\}\)\s*notifyClientOfAdminMessage/)
    })
  }
})
