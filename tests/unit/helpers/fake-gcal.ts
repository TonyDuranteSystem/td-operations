import type { GcalApi, GCalendarEntry, GEvent, GEventInput, GFreeBusy } from "@/lib/marketing/gcal"

/** An in-memory Google for the tests: calendars per mailbox, free/busy answers, and a log of EVERY call (so a test can prove what was never asked or touched). */
export class FakeGcal implements GcalApi {
  /** events by "mailbox|calendarId" */
  events = new Map<string, GEvent[]>()
  lists: Record<string, GCalendarEntry[]> = {}
  /** free/busy answers by mailbox, then calendar id */
  busy: Record<string, Record<string, GFreeBusy>> = {}
  log: string[] = []
  fail = new Set<string>()
  private n = 1

  private key = (actAs: string, cal: string) => `${actAs}|${cal}`
  private call(name: string, actAs: string, extra = "") { this.log.push(`${name} ${actAs}${extra ? " " + extra : ""}`); if (this.fail.has(name)) throw new Error(`fake ${name} failed`) }

  put(actAs: string, cal: string, e: Partial<GEvent> & { id: string; startMs: number; endMs: number }): GEvent {
    const ev: GEvent = { calendarId: cal, title: "Event", guests: [], allDay: false, marketingLeadId: null, ...e }
    this.events.set(this.key(actAs, cal), [...(this.events.get(this.key(actAs, cal)) ?? []), ev])
    return ev
  }
  all(actAs: string, cal = "primary"): GEvent[] { return this.events.get(this.key(actAs, cal)) ?? [] }
  calls(name: string): string[] { return this.log.filter(l => l.startsWith(name + " ")) }

  async calendarList(actAs: string) { this.call("calendarList", actAs); return this.lists[actAs] ?? [] }
  async freeBusy(actAs: string, ids: string[], min: string, max: string) {
    this.call("freeBusy", actAs, ids.join(","))
    const out: Record<string, GFreeBusy> = {}
    for (const id of ids) out[id] = this.busy[actAs]?.[id] ?? { busy: [], error: "notFound" }
    void min; void max
    return out
  }
  async listEvents(actAs: string, cal: string) { this.call("listEvents", actAs, cal); return [...this.all(actAs, cal)] }
  async getEvent(actAs: string, cal: string, id: string) { this.call("getEvent", actAs, id); return this.all(actAs, cal).find(e => e.id === id) ?? null }
  async createEvent(actAs: string, cal: string, i: GEventInput) {
    this.call("createEvent", actAs, i.title)
    return this.put(actAs, cal, { id: `evt${this.n++}`, title: i.title, startMs: Date.parse(i.startIso), endMs: Date.parse(i.endIso), marketingLeadId: i.leadId ?? null })
  }
  async moveEvent(actAs: string, cal: string, id: string, i: { startIso: string; endIso: string; timeZone: string }) {
    this.call("moveEvent", actAs, id)
    const ev = this.all(actAs, cal).find(e => e.id === id)
    if (!ev) throw new Error("Calendar API 404")
    ev.startMs = Date.parse(i.startIso); ev.endMs = Date.parse(i.endIso)
    return ev
  }
  async removeEvent(actAs: string, cal: string, id: string) {
    this.call("removeEvent", actAs, id)
    this.events.set(this.key(actAs, cal), this.all(actAs, cal).filter(e => e.id !== id))
  }
}
