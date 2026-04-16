import { describe, it, expect, vi } from "vitest"
import { dbWrite, dbWriteSafe } from "@/lib/db"

vi.mock("@sentry/nextjs", () => ({
  captureException: vi.fn(),
}))

import * as Sentry from "@sentry/nextjs"

describe("dbWrite", () => {
  it("returns data on success", async () => {
    const mockQuery = Promise.resolve({
      data: [{ id: "123", status: "Active" }],
      error: null,
    })
    const result = await dbWrite(mockQuery, "accounts.update")
    expect(result).toEqual([{ id: "123", status: "Active" }])
  })

  it("throws and captures to Sentry on error", async () => {
    const mockQuery = Promise.resolve({
      data: null,
      error: { message: "duplicate key", code: "23505", details: null, hint: null },
    })
    await expect(dbWrite(mockQuery, "accounts.insert")).rejects.toThrow(
      "dbWrite[accounts.insert]: duplicate key"
    )
    expect(Sentry.captureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        extra: expect.objectContaining({ label: "accounts.insert", code: "23505" }),
      })
    )
  })

  it("returns null data for mutations without .select()", async () => {
    const mockQuery = Promise.resolve({ data: null, error: null })
    const result = await dbWrite(mockQuery, "accounts.delete")
    expect(result).toBeNull()
  })
})

describe("dbWriteSafe", () => {
  it("returns data on success", async () => {
    const mockQuery = Promise.resolve({
      data: { id: "abc" },
      error: null,
    })
    const result = await dbWriteSafe(mockQuery, "tasks.update")
    expect(result).toEqual({ data: { id: "abc" }, error: null })
  })

  it("returns error string and captures to Sentry on failure", async () => {
    const mockQuery = Promise.resolve({
      data: null,
      error: { message: "not found", code: "PGRST116", details: null, hint: null },
    })
    const result = await dbWriteSafe(mockQuery, "tasks.update")
    expect(result).toEqual({ data: null, error: "not found" })
    expect(Sentry.captureException).toHaveBeenCalled()
  })
})
