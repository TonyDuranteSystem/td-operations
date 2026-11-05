import { describe, it, expect } from "vitest"
import { bookJoint, cancelJoint, createJointLink, followStaffChange, moveJoint, viewJointLink, type CallOp, type HoldRange, type JointEnv, type JointStore, type LinkRecord } from "@/lib/marketing/joint-booking"
import { timePrefsFrom } from "@/lib/marketing/time-prefs"
import type { GcalApi, GEvent } from "@/lib/marketing/gcal"
import type { ZoomApi } from "@/lib/zoom"
import { hashInviteToken } from "@/lib/marketing/invite-rules"

const NOW = Date.UTC(2026, 10, 2, 0, 0) // Monday 2 Nov 2026, 00:00 UTC (Canary UTC+0, New York UTC-5)
const T1 = Date.UTC(2026, 10, 2, 13, 0) // 8:00 am New York = 13:00 Canary: the first time both are free
const T2 = Date.UTC(2026, 10, 2, 15, 0)
const iso = (ms: number) => new Date(ms).toISOString()
const SELLER = "11111111-1111-4111-8111-111111111111"
const SELLER_MAIL = "rocco@tonydurante.us"
const OWNER_MAIL = "antonio.durante@tonydurante.us"
const prefs = timePrefsFrom({
  owner_clock: { zone: "America/New_York", label: "Antonio", email: OWNER_MAIL }, member_time_zones: { [SELLER]: "Atlantic/Canary" },
  member_call_hours: { [SELLER]: {} }, calendar_busy_enabled: true, calendar_write_through_enabled: true,
})

function fakeStore() {
  const rows = new Map<string, LinkRecord & { token_hash: string; lock: [number, number] | null }>()
  let n = 0
  const store: JointStore = {
    async byHash(h) { return [...rows.values()].find(r => r.token_hash === h) ?? null },
    async createLink(r) {
      for (const x of rows.values()) if (x.lead_id === r.leadId && x.status === "open") x.revoked_at = iso(NOW)
      const id = `row-${++n}`
      rows.set(id, { id, team_id: r.teamId, lead_id: r.leadId, seller_user_id: r.sellerUserId, lang: r.lang, status: "open", expires_at: r.expiresAt, revoked_at: null, starts_at: null, ends_at: null, client_name: null, client_email: null, client_zone: null, zoom_meeting_id: null, zoom_join_url: null, gcal_act_as: null, gcal_event_id: null, token_hash: r.tokenHash, lock: null })
    },
    async hold(id, from, range: HoldRange, client) {
      const row = rows.get(id)
      if (!row || row.status !== from || row.revoked_at) return "changed"
      const lock: [number, number] = [Date.parse(range.lockFrom), Date.parse(range.lockTo)]
      for (const o of rows.values()) if (o.id !== id && (o.status === "booking" || o.status === "booked") && o.lock && lock[0] < o.lock[1] && lock[1] > o.lock[0]) return "taken"
      Object.assign(row, { status: from === "open" ? "booking" : "booked", starts_at: range.startsAt, ends_at: range.endsAt, lock, ...(from === "open" ? { held_at: iso(NOW) } : {}) }, client ? { client_name: client.name, client_email: client.email, client_zone: client.zone, ...(client.lang ? { lang: client.lang } : {}) } : {})
      return "ok"
    },
    async releaseHold(id) { const r = rows.get(id); if (r && r.status === "booking") Object.assign(r, { status: "open", starts_at: null, ends_at: null, lock: null, client_name: null, client_email: null, client_zone: null }) },
    async restoreHold(id, range) { const r = rows.get(id); if (r) Object.assign(r, { starts_at: range.startsAt, ends_at: range.endsAt, lock: [Date.parse(range.lockFrom), Date.parse(range.lockTo)] }) },
    async finishBooking(id, v) { const r = rows.get(id); if (!r || r.status !== "booking") return false; Object.assign(r, { status: "booked", zoom_meeting_id: v.zoomMeetingId, zoom_join_url: v.zoomJoinUrl, gcal_act_as: v.gcalActAs, gcal_event_id: v.gcalEventId }); return true },
    async cancel(id) { const r = rows.get(id); if (!r || r.status !== "booked") return false; Object.assign(r, { status: "cancelled", lock: null }); return true },
    async activeFor(_t, leadId) { return [...rows.values()].find(r => r.lead_id === leadId && (r.status === "booking" || r.status === "booked") && r.ends_at && Date.parse(r.ends_at) > NOW) ?? null },
    async releaseStale(cutoff) { for (const r of rows.values()) if (r.status === "booking" && r.held_at && Date.parse(r.held_at) < Date.parse(cutoff)) Object.assign(r, { status: "open", starts_at: null, ends_at: null, lock: null, client_name: null, client_email: null, client_zone: null, held_at: null }) },
    async otherHolds(excl) { return [...rows.values()].filter(r => r.id !== excl && (r.status === "booking" || r.status === "booked") && r.starts_at && r.ends_at).map(r => ({ start: Date.parse(r.starts_at as string), end: Date.parse(r.ends_at as string) })) },
  }
  return { store, rows }
}

function makeEnv(o: { sellerBusy?: Array<{ start: number; end: number }>; ownerBusy?: Array<{ start: number; end: number }>; googleDown?: boolean; zoomFails?: boolean; eventFails?: boolean; recordFails?: boolean; removeFails?: boolean; dropFails?: boolean; zoomReady?: boolean; ownerEmail?: string | null; busyOff?: boolean; leadThrows?: boolean } = {}) {
  const { store, rows } = fakeStore()
  const calls: string[] = []
  const events = new Map<string, { actAs: string; start: string; attendees: string[]; location: string | undefined }>()
  const meetings = new Map<string, string>()
  const ops: CallOp[] = []
  const mails: Array<{ to: string; subject: string; text: string }> = []
  const synced: Array<{ kind: string; data: Record<string, unknown> }> = []
  const gcal = {
    async freeBusy(actAs: string, ids: string[]) {
      if (o.googleDown) throw new Error("down")
      const busy = actAs === OWNER_MAIL ? o.ownerBusy ?? [] : o.sellerBusy ?? []
      return Object.fromEntries(ids.map(id => [id, { busy, error: null }]))
    },
    async createEvent(actAs: string, _c: string, input: { startIso: string; attendees?: string[]; location?: string }) {
      calls.push("event.create"); if (o.eventFails) throw new Error("google refused")
      const id = `ev-${events.size + 1}`; events.set(id, { actAs, start: input.startIso, attendees: input.attendees ?? [], location: input.location }); return { id } as GEvent
    },
    async moveEvent(_a: string, _c: string, id: string, input: { startIso: string }) { calls.push("event.move"); const e = events.get(id); if (e) e.start = input.startIso; return { id } as GEvent },
    async removeEvent(_a: string, _c: string, id: string) { calls.push("event.remove"); if (o.removeFails) throw new Error("cannot remove"); events.delete(id) },
  } as unknown as GcalApi
  const zoom: ZoomApi = {
    async createMeeting() { calls.push("zoom.create"); if (o.zoomFails) throw new Error("Zoom said no"); const id = `z-${meetings.size + 1}`; meetings.set(id, "live"); return { id, joinUrl: `https://zoom.us/j/${id}` } },
    async updateMeeting() { calls.push("zoom.update") },
    async deleteMeeting(id) { calls.push("zoom.delete"); meetings.delete(id) },
  }
  const env: JointEnv = {
    store, gcal, zoom, zoomReady: () => o.zoomReady !== false, now: () => NOW, baseUrl: "https://app.example.test",
    async context() { return { prefs: { ...prefs, busyEnabled: !o.busyOff, ownerClock: { ...prefs.ownerClock, email: o.ownerEmail === null ? undefined : prefs.ownerClock.email } }, takers: [{ userId: SELLER, label: "Rocco", email: SELLER_MAIL }], ownerHours: { startMin: 480, endMin: 810, days: [1, 2, 3, 4, 5], notice: 120 }, async sellerAppointments() { return [] } } },
    async lead(_t, id) { if (o.leadThrows) throw new Error("db blip"); return { id, full_name: "Marco Rossi", email: null, phone: "+39 333 1234567", country: null, claimed_by: SELLER } },
    async recordCall(_t, _l, op) { ops.push(op); return o.recordFails ? { ok: false, error: "no" } : { ok: true } },
    async recordSynced(_l, kind, data) { synced.push({ kind, data }) },
    async sendMail(to, mail) { mails.push({ to, subject: mail.subject, text: mail.text }) },
    async tellSeller() { calls.push("tell") },
    // the person's earlier calendar entry goes first: when it runs the client's own entry does not exist yet
    async dropStaffCalendarEvent() { calls.push(`drop-staff(events:${events.size})`); if (o.dropFails) throw new Error("google blip") },
  }
  return { env, rows, calls, events, meetings, ops, mails, synced }
}

async function linked(o: Parameters<typeof makeEnv>[0] = {}) {
  const m = makeEnv(o)
  const r = await createJointLink(m.env, { teamId: "team-1", leadId: "lead-1", createdBy: "rocco@tonydurante.us" })
  if (r.ok === false) throw new Error(r.error)
  return { ...m, token: r.token, link: r }
}
const who = { name: "Marco Rossi", email: "marco@example.com", zone: "Europe/Rome" }

describe("createJointLink", () => {
  it("makes a link in the lead's language with a hashed token", async () => {
    const m = await linked()
    expect(m.link.url).toBe(`https://app.example.test/marketing/book/${m.token}`)
    expect(m.link.lang).toBe("it") // +39 number
    expect([...m.rows.values()][0].token_hash).toBe(hashInviteToken(m.token))
    expect(JSON.stringify([...m.rows.values()])).not.toContain(m.token)
  })
  it("takes back an earlier open link of the same lead", async () => {
    const m = makeEnv()
    const a = await createJointLink(m.env, { teamId: "t", leadId: "lead-1", createdBy: null })
    const b = await createJointLink(m.env, { teamId: "t", leadId: "lead-1", createdBy: null })
    expect(a.ok && b.ok).toBe(true)
    expect(((await viewJointLink(m.env, a.ok ? a.token : "")) as { state: string }).state).toBe("unusable")
    expect(((await viewJointLink(m.env, b.ok ? b.token : "")) as { state: string }).state).toBe("open")
  })
  it("refuses, in plain words, when Zoom, the calendar times or Antonio's calendar are not ready", async () => {
    for (const o of [{ zoomReady: false }, { busyOff: true }, { ownerEmail: null }]) {
      const r = await createJointLink(makeEnv(o).env, { teamId: "t", leadId: "lead-1", createdBy: null })
      expect(r.ok).toBe(false)
    }
  })
})

describe("viewJointLink", () => {
  it("shows only start times and the first name", async () => {
    const m = await linked()
    const v = await viewJointLink(m.env, m.token)
    expect(v.state).toBe("open")
    if (v.state !== "open") return
    expect(v.firstName).toBe("Marco")
    expect(v.starts[0]).toBe(iso(T1))
    expect(Object.keys(v).sort()).toEqual(["firstName", "lang", "minutes", "sellerLabel", "starts", "state"])
  })
  it("offers nothing when Google cannot answer", async () => {
    const m = await linked({ googleDown: true })
    expect((await viewJointLink(m.env, m.token)).state).toBe("unavailable")
  })
  it("answers 'unusable' for a made-up or malformed token", async () => {
    const m = makeEnv()
    expect((await viewJointLink(m.env, "x")).state).toBe("unusable")
    expect((await viewJointLink(m.env, "A".repeat(43))).state).toBe("unusable")
  })
  it("leaves out a time the seller or Antonio is busy", async () => {
    const m = await linked({ ownerBusy: [{ start: T1, end: T1 + 30 * 60_000 }] })
    const v = await viewJointLink(m.env, m.token)
    expect(v.state === "open" && v.starts.includes(iso(T1))).toBe(false)
  })
})

describe("bookJoint", () => {
  it("books: holds the time, makes the Zoom meeting and one event with Antonio and the client invited, writes the call, emails", async () => {
    const m = await linked()
    const r = await bookJoint(m.env, m.token, { startIso: iso(T1), ...who })
    expect(r.ok).toBe(true)
    expect([...m.rows.values()][0].status).toBe("booked")
    expect([...m.events.values()][0].attendees).toEqual([OWNER_MAIL, "marco@example.com"])
    expect([...m.events.values()][0].location).toMatch(/^https:\/\/zoom\.us\/j\//)
    expect(m.ops[0]).toMatchObject({ kind: "set", at: iso(T1) })
    expect(m.mails).toHaveLength(1)
    expect(m.mails[0].to).toBe("marco@example.com")
    expect(m.synced[0]).toMatchObject({ kind: "calendar_synced", data: { act_as: SELLER_MAIL, removed: false } })
    expect(((await viewJointLink(m.env, m.token)) as { state: string }).state).toBe("booked")
  })
  it("takes the person's earlier calendar entry off before the client's own is written (a leftover entry stayed on the seller's calendar for good, 5 Nov 2026)", async () => {
    const m = await linked()
    expect((await bookJoint(m.env, m.token, { startIso: iso(T1), ...who })).ok).toBe(true)
    expect(m.calls.filter(c => c.startsWith("drop-staff"))).toEqual(["drop-staff(events:0)"])
    expect(m.events.size).toBe(1)
  })
  it("a failed removal of the earlier entry never stops the client's booking", async () => {
    const m = await linked({ dropFails: true })
    expect((await bookJoint(m.env, m.token, { startIso: iso(T1), ...who })).ok).toBe(true)
    expect([...m.rows.values()][0].status).toBe("booked")
  })
  it("a booking that cannot be saved does not touch the earlier entry", async () => {
    const m = await linked({ recordFails: true })
    expect((await bookJoint(m.env, m.token, { startIso: iso(T1), ...who })).ok).toBe(false)
    expect(m.calls.filter(c => c.startsWith("drop-staff"))).toEqual([])
  })
  it("refuses a time that is not on the offered list", async () => {
    const m = await linked()
    const r = await bookJoint(m.env, m.token, { startIso: iso(T1 + 7 * 60_000), ...who })
    expect(r.ok).toBe(false)
    expect(m.calls).toEqual([])
  })
  it("two clients on the same time: the second is told it was taken and nothing is made for it", async () => {
    const m = await linked()
    const other = await createJointLink(m.env, { teamId: "team-1", leadId: "lead-2", createdBy: null })
    if (other.ok === false) throw new Error("no link")
    expect((await bookJoint(m.env, m.token, { startIso: iso(T1), ...who })).ok).toBe(true)
    const before = m.calls.length
    const r = await bookJoint(m.env, other.token, { startIso: iso(T1), ...who })
    expect(r.ok).toBe(false)
    expect(m.calls.length).toBe(before)
  })
  it("a time that became busy between the list and the confirmation is refused and the hold is released", async () => {
    const m = await linked()
    // the calendar is asked once for the page, once to check, once again after the hold: make the third answer busy
    let asked = 0
    const real = m.env.gcal.freeBusy.bind(m.env.gcal)
    m.env.gcal.freeBusy = (async (...a: Parameters<typeof real>) => { asked++; const r = await real(...a); return asked > 2 ? Object.fromEntries(Object.keys(r).map(k => [k, { busy: [{ start: T1, end: T1 + 30 * 60_000 }], error: null }])) : r }) as typeof real
    const r = await bookJoint(m.env, m.token, { startIso: iso(T1), ...who })
    expect(r.ok).toBe(false)
    expect([...m.rows.values()][0].status).toBe("open")
    expect(m.calls).toEqual([])
  })
  it("Zoom failing releases the time and makes no calendar event", async () => {
    const m = await linked({ zoomFails: true })
    const r = await bookJoint(m.env, m.token, { startIso: iso(T1), ...who })
    expect(r.ok).toBe(false)
    expect([...m.rows.values()][0].status).toBe("open")
    expect(m.events.size).toBe(0)
  })
  it("Google refusing the event deletes the Zoom meeting and releases the time", async () => {
    const m = await linked({ eventFails: true })
    expect((await bookJoint(m.env, m.token, { startIso: iso(T1), ...who })).ok).toBe(false)
    expect(m.meetings.size).toBe(0)
    expect([...m.rows.values()][0].status).toBe("open")
  })
  it("failing to write the call takes back the event and the meeting", async () => {
    const m = await linked({ recordFails: true })
    expect((await bookJoint(m.env, m.token, { startIso: iso(T1), ...who })).ok).toBe(false)
    expect(m.events.size).toBe(0)
    expect(m.meetings.size).toBe(0)
    expect([...m.rows.values()][0].status).toBe("open")
  })
  it("needs a valid email and a name", async () => {
    const m = await linked()
    expect((await bookJoint(m.env, m.token, { startIso: iso(T1), name: "Marco", email: "nope", zone: "Europe/Rome" })).ok).toBe(false)
    expect((await bookJoint(m.env, m.token, { startIso: iso(T1), name: "  ", email: "a@b.co", zone: "Europe/Rome" })).ok).toBe(false)
  })
  it("a booked link cannot book a second call", async () => {
    const m = await linked()
    await bookJoint(m.env, m.token, { startIso: iso(T1), ...who })
    expect((await bookJoint(m.env, m.token, { startIso: iso(T2), ...who })).ok).toBe(false)
  })
})

describe("moveJoint", () => {
  it("moves the same Zoom meeting and the same event, and writes the move", async () => {
    const m = await linked()
    await bookJoint(m.env, m.token, { startIso: iso(T1), ...who })
    const r = await moveJoint(m.env, m.token, { startIso: iso(T2) })
    expect(r.ok).toBe(true)
    expect(m.calls).toContain("zoom.update")
    expect(m.calls).toContain("event.move")
    expect(m.calls.filter(c => c === "zoom.create")).toHaveLength(1)
    expect(m.ops[1]).toMatchObject({ kind: "move", at: iso(T2), from: iso(T1) })
    expect([...m.rows.values()][0].starts_at).toBe(iso(T2))
  })
  it("refuses the time it already has and a time that is not offered", async () => {
    const m = await linked()
    await bookJoint(m.env, m.token, { startIso: iso(T1), ...who })
    expect((await moveJoint(m.env, m.token, { startIso: iso(T1) })).ok).toBe(false)
    expect((await moveJoint(m.env, m.token, { startIso: iso(T1 + 60_000) })).ok).toBe(false)
  })
  it("puts everything back when writing the move fails", async () => {
    const m = await linked()
    await bookJoint(m.env, m.token, { startIso: iso(T1), ...who })
    const real = m.env.recordCall
    m.env.recordCall = async (t, l, op) => (op.kind === "move" ? { ok: false, error: "no" } : real(t, l, op))
    expect((await moveJoint(m.env, m.token, { startIso: iso(T2) })).ok).toBe(false)
    expect([...m.rows.values()][0].starts_at).toBe(iso(T1))
    expect([...m.events.values()][0].start).toBe(iso(T1))
  })
})

describe("cancelJoint", () => {
  it("cancels: Zoom and the event are removed, the call is written as cancelled, the client and the seller are told", async () => {
    const m = await linked()
    await bookJoint(m.env, m.token, { startIso: iso(T1), ...who })
    const r = await cancelJoint(m.env, m.token)
    expect(r).toEqual({ ok: true, warnings: [] })
    expect(m.meetings.size).toBe(0)
    expect(m.events.size).toBe(0)
    expect(m.ops[1]).toMatchObject({ kind: "cancel" })
    expect(m.mails).toHaveLength(2)
    expect(((await viewJointLink(m.env, m.token)) as { state: string }).state).toBe("cancelled")
  })
  it("a second cancel does nothing more", async () => {
    const m = await linked()
    await bookJoint(m.env, m.token, { startIso: iso(T1), ...who })
    await cancelJoint(m.env, m.token)
    const calls = m.calls.length
    expect((await cancelJoint(m.env, m.token)).ok).toBe(false)
    expect(m.calls.length).toBe(calls)
  })
  it("still cancels for the client when Google cannot remove the event, and says so for the seller", async () => {
    const m = await linked({ removeFails: true })
    await bookJoint(m.env, m.token, { startIso: iso(T1), ...who })
    const r = await cancelJoint(m.env, m.token)
    expect(r.ok && r.warnings.length).toBe(1)
    expect(m.synced.some(s => s.kind === "calendar_sync_failed")).toBe(true)
    expect([...m.rows.values()][0].status).toBe("cancelled")
  })
  it("frees the time for another client", async () => {
    const m = await linked()
    const other = await createJointLink(m.env, { teamId: "team-1", leadId: "lead-2", createdBy: null })
    if (other.ok === false) throw new Error("no link")
    await bookJoint(m.env, m.token, { startIso: iso(T1), ...who })
    await cancelJoint(m.env, m.token)
    expect((await bookJoint(m.env, other.token, { startIso: iso(T1), ...who })).ok).toBe(true)
  })
})

describe("the three fixes after the bug hunt", () => {
  it("refuses a new link while the lead has a call booked, and allows one after it is cancelled", async () => {
    const m = await linked()
    const v = await viewJointLink(m.env, m.token) as { starts: string[] }
    expect((await bookJoint(m.env, m.token, { startIso: v.starts[0], ...who })).ok).toBe(true)
    const again = await createJointLink(m.env, { teamId: "team-1", leadId: "lead-1", createdBy: null })
    expect(again.ok).toBe(false)
    expect(again.ok === false && again.status).toBe(409)
    expect((await cancelJoint(m.env, m.token)).ok).toBe(true)
    expect((await createJointLink(m.env, { teamId: "team-1", leadId: "lead-1", createdBy: null })).ok).toBe(true)
  })
  it("gives the time back when the lead lookup fails after the hold", async () => {
    const m = await linked()
    const v = await viewJointLink(m.env, m.token) as { starts: string[] }
    let calls = 0
    const real = m.env.lead
    m.env.lead = async (t, i) => { if (++calls >= 1) throw new Error("db blip"); return real(t, i) }
    const r = await bookJoint(m.env, m.token, { startIso: v.starts[0], ...who })
    expect(r.ok).toBe(false)
    const row = [...m.rows.values()][0]
    expect(row.status).toBe("open")
    expect(row.lock).toBeNull()
  })
  it("heals a booking that was cut off halfway", async () => {
    const m = await linked()
    const row = [...m.rows.values()][0]
    Object.assign(row, { status: "booking", starts_at: iso(T1), ends_at: iso(T1 + 1800_000), lock: [T1, T1 + 3600_000], held_at: iso(NOW - 10 * 60_000) })
    const v = await viewJointLink(m.env, m.token)
    expect(v.state).toBe("open")
    expect(row.status).toBe("open")
  })
  it("leaves a fresh booking-in-progress alone", async () => {
    const m = await linked()
    const row = [...m.rows.values()][0]
    Object.assign(row, { status: "booking", starts_at: iso(T1), ends_at: iso(T1 + 1800_000), lock: [T1, T1 + 3600_000], held_at: iso(NOW - 60_000) })
    expect((await viewJointLink(m.env, m.token)).state).toBe("unusable")
    expect(row.status).toBe("booking")
  })
  it("a staff move in the Calendar moves the link, Zoom and tells the client", async () => {
    const m = await linked()
    const v = await viewJointLink(m.env, m.token) as { starts: string[] }
    await bookJoint(m.env, m.token, { startIso: v.starts[0], ...who })
    m.calls.length = 0; m.mails.length = 0
    const note = await followStaffChange(m.env, { teamId: "team-1", leadId: "lead-1", change: { kind: "set", at: v.starts[8] } })
    expect(note).toBeNull()
    const row = [...m.rows.values()][0]
    expect(row.starts_at).toBe(v.starts[8])
    expect(m.calls).toContain("zoom.update")
    expect(m.mails).toHaveLength(1)
    expect(m.mails[0].to).toBe(who.email)
  })
  it("a staff cancel in the Calendar cancels the link, deletes Zoom and tells the client", async () => {
    const m = await linked()
    const v = await viewJointLink(m.env, m.token) as { starts: string[] }
    await bookJoint(m.env, m.token, { startIso: v.starts[0], ...who })
    m.calls.length = 0; m.mails.length = 0
    expect(await followStaffChange(m.env, { teamId: "team-1", leadId: "lead-1", change: { kind: "cancel" } })).toBeNull()
    expect([...m.rows.values()][0].status).toBe("cancelled")
    expect(m.calls).toContain("zoom.delete")
    expect(m.mails).toHaveLength(1)
  })
  it("a staff change on a lead without a booking link does nothing", async () => {
    const m = makeEnv()
    expect(await followStaffChange(m.env, { teamId: "team-1", leadId: "lead-9", change: { kind: "cancel" } })).toBeNull()
    expect(m.calls).toEqual([])
  })
  it("a staff move onto a time another booked call holds keeps the link where it was and says so", async () => {
    const m = await linked()
    const v = await viewJointLink(m.env, m.token) as { starts: string[] }
    await bookJoint(m.env, m.token, { startIso: v.starts[0], ...who })
    // another lead's booked call on the new time
    const other = await createJointLink(m.env, { teamId: "team-1", leadId: "lead-2", createdBy: null })
    if (other.ok === false) throw new Error(other.error)
    const ov = await viewJointLink(m.env, other.token) as { starts: string[] }
    expect((await bookJoint(m.env, other.token, { startIso: ov.starts[8], ...who })).ok).toBe(true)
    const note = await followStaffChange(m.env, { teamId: "team-1", leadId: "lead-1", change: { kind: "set", at: ov.starts[8] } })
    expect(note).toMatch(/kept its old time/)
    expect([...m.rows.values()][0].starts_at).toBe(v.starts[0])
  })
})

describe("the leftovers after the production test", () => {
  it("when the call cannot be written on the lead, Google is never asked to invite anybody", async () => {
    const m = await linked({ recordFails: true })
    expect((await bookJoint(m.env, m.token, { startIso: iso(T1), ...who })).ok).toBe(false)
    expect(m.calls).not.toContain("event.create")
    expect(m.meetings.size).toBe(0)
  })
  it("the invitation is made only after the call is written", async () => {
    const m = await linked()
    expect((await bookJoint(m.env, m.token, { startIso: iso(T1), ...who })).ok).toBe(true)
    expect(m.calls.indexOf("zoom.create")).toBeLessThan(m.calls.indexOf("event.create"))
    expect(m.ops[0]).toMatchObject({ kind: "set" })
  })
  it("the emails follow the language the client chose on the page, then stay in it", async () => {
    const m = await linked() // the lead has an Italian number, so the link starts in Italian
    expect([...m.rows.values()][0].lang).toBe("it")
    expect((await bookJoint(m.env, m.token, { startIso: iso(T1), ...who, lang: "en" })).ok).toBe(true)
    expect([...m.rows.values()][0].lang).toBe("en")
    expect(m.mails[0].subject).not.toMatch(/Chiamata/)
    expect((await cancelJoint(m.env, m.token)).ok).toBe(true)
    expect(m.mails[1].subject).not.toMatch(/Chiamata/)
  })
  it("a language that is neither it nor en is ignored", async () => {
    const m = await linked()
    expect((await bookJoint(m.env, m.token, { startIso: iso(T1), ...who, lang: "fr" })).ok).toBe(true)
    expect([...m.rows.values()][0].lang).toBe("it")
  })
})

describe("every refusal the client page can show has an Italian text", () => {
  it("covers each sentence in the booking code and the route", async () => {
    const { readFileSync } = await import("node:fs")
    const { jointErrorText, jointErrorKeys } = await import("@/lib/marketing/joint-errors")
    const { GENERIC_LINK_ERROR, TIME_TAKEN_ERROR } = await import("@/lib/marketing/joint-rules")
    const found = new Set<string>()
    for (const f of ["lib/marketing/joint-booking.ts", "app/api/marketing/book/[token]/route.ts"]) {
      for (const m of readFileSync(f, "utf8").matchAll(/(?:nope|fail)\("([^"]+)"/g)) found.add(m[1])
    }
    found.add("Something went wrong. Please try again in a moment.")
    expect(found.size).toBeGreaterThan(6)
    for (const e of found) expect(jointErrorKeys(), e).toContain(e)
    expect(jointErrorKeys()).toContain(GENERIC_LINK_ERROR)
    expect(jointErrorKeys()).toContain(TIME_TAKEN_ERROR)
    expect(jointErrorText(TIME_TAKEN_ERROR, "it")).toMatch(/orario/)
    expect(jointErrorText(TIME_TAKEN_ERROR, "en")).toBe(TIME_TAKEN_ERROR)
    expect(jointErrorText("A sentence nobody wrote", "it")).toBe("A sentence nobody wrote")
  })
})
