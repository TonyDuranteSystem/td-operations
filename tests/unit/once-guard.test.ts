import { describe, it, expect } from "vitest"
import { createOnceGuard } from "@/lib/crm-store/once-guard"

describe("createOnceGuard — one irreversible action per click burst", () => {
  it("three calls in the same instant run the action ONCE", async () => {
    const g = createOnceGuard(); let n = 0
    const act = async () => { n++; await new Promise((r) => setTimeout(r, 10)); return "sent" }
    const out = await Promise.all([g.run(act), g.run(act), g.run(act)])
    expect(n).toBe(1)
    expect(out).toEqual(["sent", undefined, undefined])
  })
  it("the guard is busy while running and opens again afterwards (also after a failure)", async () => {
    const g = createOnceGuard()
    const p = g.run(async () => { await new Promise((r) => setTimeout(r, 5)) })
    expect(g.busy).toBe(true)
    await p; expect(g.busy).toBe(false)
    await expect(g.run(async () => { throw new Error("boom") })).rejects.toThrow("boom")
    expect(g.busy).toBe(false)
    expect(await g.run(async () => 1)).toBe(1)
  })
})
