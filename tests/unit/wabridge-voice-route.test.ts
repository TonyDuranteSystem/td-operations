import { describe, it, expect, vi, beforeEach } from "vitest"

const ID = "7c1d2f4e-9a3b-4c5d-8e6f-0a1b2c3d4e5f"

const st = vi.hoisted(() => ({
  denied: false,
  media: null as null | Record<string, unknown>,
  mediaError: null as null | { message: string },
  signError: false,
  signedFor: [] as string[],
}))

vi.mock("@/lib/auth/require-staff-route", () => ({
  requireStaffRoute: async () => (st.denied ? new Response(JSON.stringify({ error: "Not authorized" }), { status: 403 }) : null),
}))
// The Sep 26 rule ("only staff may listen") is gone: if anything puts that check back, this makes the route blow up.
vi.mock("@/lib/auth", () => ({
  isStaffUser: () => {
    throw new Error("voice playback must not check isStaffUser any more (Antonio, 2026-11-04)")
  },
}))
vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: {
    from: () => {
      const c: Record<string, unknown> = {}
      for (const op of ["select", "eq"]) c[op] = () => c
      c.maybeSingle = async () => ({ data: st.media, error: st.mediaError })
      return c
    },
    storage: {
      from: () => ({
        createSignedUrl: async (path: string) => {
          st.signedFor.push(path)
          return st.signError ? { data: null, error: { message: "nope" } } : { data: { signedUrl: `https://signed.example/${path}` }, error: null }
        },
      }),
    },
  },
}))

import { GET } from "@/app/api/inbox/whatsapp/voice/[messageId]/route"

const play = (id = ID) => GET({} as never, { params: { messageId: id } })

beforeEach(() => {
  st.denied = false
  st.media = { status: "ready", storage_path: "voice/abc.m4a", audio_deleted_at: null }
  st.mediaError = null
  st.signError = false
  st.signedFor = []
})

describe("GET /api/inbox/whatsapp/voice/[messageId] — listening is open to anyone who can use the Inbox", () => {
  it("hands back a short-lived link for a ready note, never cached, and never asks whether the caller is 'staff'", async () => {
    const res = await play()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ url: "https://signed.example/voice/abc.m4a" })
    expect(res.headers.get("Cache-Control")).toBe("no-store")
    expect(st.signedFor).toEqual(["voice/abc.m4a"])
  })

  it("a portal client is still refused by the route gate and nothing is signed", async () => {
    st.denied = true
    expect((await play()).status).toBe(403)
    expect(st.signedFor).toHaveLength(0)
  })

  it("rejects an id that is not a uuid", async () => {
    expect((await play("../../etc/passwd")).status).toBe(404)
    expect(st.signedFor).toHaveLength(0)
  })

  it.each([
    ["no media row", null],
    ["still preparing", { status: "pending", storage_path: "voice/a", audio_deleted_at: null }],
    ["expired", { status: "expired", storage_path: null, audio_deleted_at: null }],
    ["audio deleted after 180 days", { status: "ready", storage_path: "voice/a", audio_deleted_at: "2027-01-01T00:00:00Z" }],
  ])("%s → 'not available', nothing signed", async (_label, media) => {
    st.media = media
    expect((await play()).status).toBe(404)
    expect(st.signedFor).toHaveLength(0)
  })

  it("a database or signing failure is a plain 500, never a leaked link", async () => {
    st.mediaError = { message: "db down" }
    expect((await play()).status).toBe(500)
    st.mediaError = null
    st.signError = true
    const res = await play()
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).not.toContain("signed.example")
  })
})
