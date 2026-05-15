/**
 * dispatchTaskAction — client API wrapper.
 *
 * Verifies idempotency-key generation, body shape, and per-R099 error
 * surfacing (we propagate the server's `error` field rather than swallowing
 * into a generic toast).
 */

import { beforeEach, describe, expect, it, vi } from "vitest"
import { dispatchTaskAction } from "@/lib/tasks/client-api"

beforeEach(() => {
  // @ts-expect-error overriding global fetch in vitest
  globalThis.fetch = vi.fn()
})

function mockFetch(status: number, body: unknown) {
  // @ts-expect-error mock signature
  globalThis.fetch.mockResolvedValueOnce({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  })
}

describe("dispatchTaskAction — request shape", () => {
  it("POSTs to /api/tasks/{id}/action with the expected body", async () => {
    mockFetch(200, { ok: true, log_id: "log-1" })
    await dispatchTaskAction({
      taskId: "task-1",
      actionSlug: "approve_send",
      params: { foo: "bar" },
      expectedStatus: "To Do",
      idempotencyKey: "fixed-key",
    })
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "/api/tasks/task-1/action",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action_slug: "approve_send",
          params: { foo: "bar" },
          idempotency_key: "fixed-key",
          expected_status: "To Do",
          mode: "execute",
        }),
      }),
    )
  })

  it("generates a unique idempotency key when none is supplied", async () => {
    mockFetch(200, { ok: true })
    mockFetch(200, { ok: true })
    await dispatchTaskAction({ taskId: "t", actionSlug: "approve_send" })
    await dispatchTaskAction({ taskId: "t", actionSlug: "approve_send" })
    // @ts-expect-error mock typing
    const body1 = JSON.parse(globalThis.fetch.mock.calls[0][1].body)
    // @ts-expect-error mock typing
    const body2 = JSON.parse(globalThis.fetch.mock.calls[1][1].body)
    expect(body1.idempotency_key).toBeTruthy()
    expect(body2.idempotency_key).toBeTruthy()
    expect(body1.idempotency_key).not.toBe(body2.idempotency_key)
  })

  it("uses mode='preview' when requested", async () => {
    mockFetch(200, { ok: true, preview: { portal_message: "hi" } })
    await dispatchTaskAction({
      taskId: "t",
      actionSlug: "approve_send",
      mode: "preview",
      idempotencyKey: "k",
    })
    // @ts-expect-error mock typing
    const body = JSON.parse(globalThis.fetch.mock.calls[0][1].body)
    expect(body.mode).toBe("preview")
  })
})

describe("dispatchTaskAction — response handling", () => {
  it("returns the server payload on 200", async () => {
    mockFetch(200, { ok: true, log_id: "L1", next_status: "Done" })
    const result = await dispatchTaskAction({
      taskId: "t",
      actionSlug: "approve_send",
      idempotencyKey: "k",
    })
    expect(result.ok).toBe(true)
    expect(result.log_id).toBe("L1")
    expect(result.next_status).toBe("Done")
  })

  it("surfaces the server's error string on non-2xx (R099)", async () => {
    mockFetch(403, { error: "Role 'team' not permitted for action 'approve'" })
    const result = await dispatchTaskAction({
      taskId: "t",
      actionSlug: "approve",
      idempotencyKey: "k",
    })
    expect(result.ok).toBe(false)
    expect(result.status).toBe(403)
    expect(result.error).toBe("Role 'team' not permitted for action 'approve'")
  })

  it("returns a clear error on network failure", async () => {
    // @ts-expect-error
    globalThis.fetch.mockRejectedValueOnce(new Error("network down"))
    const result = await dispatchTaskAction({
      taskId: "t",
      actionSlug: "approve",
      idempotencyKey: "k",
    })
    expect(result.ok).toBe(false)
    expect(result.status).toBe(0)
    expect(result.error).toBe("network down")
  })

  it("falls back to a generic message when the server returns no error field", async () => {
    mockFetch(500, {})
    const result = await dispatchTaskAction({
      taskId: "t",
      actionSlug: "approve",
      idempotencyKey: "k",
    })
    expect(result.ok).toBe(false)
    expect(result.error).toBe("Request failed with status 500")
  })
})
