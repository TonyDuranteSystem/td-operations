/**
 * A file's attach-ref used to die the moment the request that carried it
 * ended (dev job eefac886, Luca — Payset/Dragos, passport + utility bill
 * "not available this turn" TWICE in one real conversation, even after
 * clicking Confirm). This is the fix: files uploaded in a recent prior turn
 * of the SAME thread stay offered, re-minted with a FRESH server ref every
 * time — never a stale ref the model remembered from earlier.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

const h = vi.hoisted(() => ({
  rows: [] as Array<{ context_json: unknown }>,
  lastQuery: { threadId: "", limit: 0 },
}))

vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      if (table !== "agent_messages") throw new Error(`unexpected table ${table}`)
      return {
        select: () => ({
          eq: (_col: string, threadId: string) => ({
            order: () => ({
              limit: (n: number) => {
                h.lastQuery = { threadId, limit: n }
                return Promise.resolve({ data: h.rows, error: null })
              },
            }),
          }),
        }),
      }
    },
  },
}))

import {
  buildPersistedTurnAttachments,
  harvestRecentWorkerUploads,
  WORKER_UPLOAD_HARVEST_TURNS,
} from "@/lib/inbox/worker-upload-harvest"
import { sendableFromRecentUploads } from "@/lib/inbox/sendable-attachment"

beforeEach(() => {
  h.rows = []
  h.lastQuery = { threadId: "", limit: 0 }
})

describe("buildPersistedTurnAttachments — what gets written for a later turn to find", () => {
  it("maps this turn's upload refs into the persisted shape", () => {
    const out = buildPersistedTurnAttachments([
      { id: "worker-chat/a.pdf", name: "passport.pdf", mimetype: "application/pdf", size: 1200 },
      { id: "worker-chat/b.pdf", name: "utility.pdf", mimetype: "application/pdf", size: 900 },
    ])
    expect(out).toEqual([
      { path: "worker-chat/a.pdf", name: "passport.pdf", content_type: "application/pdf", size: 1200 },
      { path: "worker-chat/b.pdf", name: "utility.pdf", content_type: "application/pdf", size: 900 },
    ])
  })

  it("drops an entry with no real path — never persists garbage", () => {
    const out = buildPersistedTurnAttachments([{ id: "", name: "nothing" }])
    expect(out).toEqual([])
  })

  it("returns an empty array for an empty turn", () => {
    expect(buildPersistedTurnAttachments([])).toEqual([])
  })
})

describe("harvestRecentWorkerUploads — the read side", () => {
  it("REGRESSION: recovers a file shared in an earlier turn — the exact gap this fixes", async () => {
    h.rows = [{ context_json: { attachments: [{ path: "worker-chat/passport.pdf", name: "passport.pdf", content_type: "application/pdf", size: 1200 }] } }]
    const out = await harvestRecentWorkerUploads("thread-1", new Set())
    expect(out).toEqual([{ id: "worker-chat/passport.pdf", name: "passport.pdf", mimetype: "application/pdf", size: 1200 }])
  })

  it("excludes a path already staged THIS turn — the current upload stays the only copy offered", async () => {
    h.rows = [{ context_json: { attachments: [{ path: "worker-chat/a.pdf", name: "a.pdf" }] } }]
    const out = await harvestRecentWorkerUploads("thread-1", new Set(["worker-chat/a.pdf"]))
    expect(out).toEqual([])
  })

  it("dedupes the SAME file shared across two turns down to one entry, keeping the newest", async () => {
    // Rows arrive newest-first (order by created_at desc) — the newest copy wins.
    h.rows = [
      { context_json: { attachments: [{ path: "worker-chat/a.pdf", name: "a-reshared.pdf" }] } },
      { context_json: { attachments: [{ path: "worker-chat/a.pdf", name: "a-original.pdf" }] } },
    ]
    const out = await harvestRecentWorkerUploads("thread-1", new Set())
    expect(out).toHaveLength(1)
    expect(out[0].name).toBe("a-reshared.pdf")
  })

  it("queries only the given thread, bounded to WORKER_UPLOAD_HARVEST_TURNS rows", async () => {
    await harvestRecentWorkerUploads("thread-xyz", new Set())
    expect(h.lastQuery).toEqual({ threadId: "thread-xyz", limit: WORKER_UPLOAD_HARVEST_TURNS })
  })

  it("ignores a turn with no attachments field at all", async () => {
    h.rows = [{ context_json: { source: "crm-worker" } }]
    expect(await harvestRecentWorkerUploads("thread-1", new Set())).toEqual([])
  })

  it("returns empty rather than throwing when there is no threadId", async () => {
    expect(await harvestRecentWorkerUploads("", new Set())).toEqual([])
  })
})

describe("sendableFromRecentUploads — minting refs for historical files", () => {
  it("mints up-prefixed refs, sourced as worker_upload (never chat_asset)", () => {
    const files = sendableFromRecentUploads(
      [{ id: "worker-chat/a.pdf", name: "a.pdf" }, { id: "worker-chat/b.pdf", name: "b.pdf" }],
      3,
    )
    expect(files.map((f) => f.ref)).toEqual(["up3", "up4"])
    expect(files.every((f) => f.source === "worker_upload")).toBe(true)
    expect(files[0].origin).toMatch(/earlier in this conversation/)
  })

  it("returns nothing for an empty list", () => {
    expect(sendableFromRecentUploads([], 1)).toEqual([])
  })
})
