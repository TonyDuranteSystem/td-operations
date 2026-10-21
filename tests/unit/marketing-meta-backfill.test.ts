import { describe, it, expect } from "vitest"
import { extractContact, fieldKey, mapGraphLead } from "@/lib/marketing/meta-leads/map-lead"
import { planLeadBackfill, runContactBackfill } from "@/lib/marketing/meta-leads/backfill"
import { FakeDb } from "./helpers/fake-lead-db"

const answers = (o: Record<string, string>) => Object.entries(o).map(([name, v]) => ({ name, values: [v] }))
// the real shape of Antonio's form (names as Meta sends them)
const ITALIAN = answers({ "che_attività_hai?": "servizi_e_consulenze", "dove_vivi_oggi?": "fuori_dall'italia", "e-mail": "Fabrizio.Sacchi@Outlook.com", nome_e_cognome: "Fabrizio Sacchi", numero_di_telefono: "+40757906127" })

describe("field names", () => {
  it("compares names without case, accents, dashes or spaces", () => {
    expect(fieldKey("E-mail")).toBe("e_mail")
    expect(fieldKey("Città")).toBe("citta")
    expect(fieldKey("  Numero di telefono ")).toBe("numero_di_telefono")
  })
})

describe("extractContact", () => {
  it("reads Antonio's Italian form: name, email (lower case) and phone", () => {
    expect(extractContact(ITALIAN)).toMatchObject({ fullName: "Fabrizio Sacchi", email: "fabrizio.sacchi@outlook.com", phone: "+40757906127" })
  })
  it("still reads Meta's standard English names", () => {
    expect(extractContact(answers({ full_name: "Mario Rossi", email: "m@x.com", phone_number: "+39 333 111 2233" }))).toMatchObject({ fullName: "Mario Rossi", email: "m@x.com", phone: "+393331112233" })
    expect(extractContact(answers({ first_name: "Ana", last_name: "Bianchi" })).fullName).toBe("Ana Bianchi")
  })
  it("builds the name from separate Italian fields", () => {
    expect(extractContact(answers({ nome: "Giulia", cognome: "Verdi" })).fullName).toBe("Giulia Verdi")
    expect(extractContact(answers({ telefono: "0039 333 4445566", "E-Mail": "g@x.com" }))).toMatchObject({ phone: "+393334445566", email: "g@x.com" })
  })
  it("a form with none of these fields gives nothing, never a guess", () => {
    expect(extractContact(answers({ "che_attività_hai?": "x" }))).toEqual({ fullName: null, email: null, phone: null, country: null, city: null })
    expect(extractContact([])).toEqual({ fullName: null, email: null, phone: null, country: null, city: null })
  })
  it("Meta's Test lead button: named 'Meta test lead', dummy email and phone dropped", () => {
    const t = answers({ nome_e_cognome: "<test lead: dummy data for nome_e_cognome>", "e-mail": "<test lead: dummy data for e-mail>", numero_di_telefono: "<test lead: dummy data for numero_di_telefono>" })
    expect(extractContact(t)).toMatchObject({ fullName: "Meta test lead", email: null, phone: null })
  })
  it("a value that is not an email or not a phone is not kept", () => {
    expect(extractContact(answers({ "e-mail": "not an email", numero_di_telefono: "12" }))).toMatchObject({ email: null, phone: null })
  })
  it("new leads from the Meta feed are mapped with the same rules", () => {
    const m = mapGraphLead({ id: "9", field_data: ITALIAN.map(a => ({ name: a.name, values: a.values })) })
    expect(m).toMatchObject({ fullName: "Fabrizio Sacchi", email: "fabrizio.sacchi@outlook.com", phone: "+40757906127" })
    expect(m.answers).toHaveLength(5)
  })
})

describe("planLeadBackfill", () => {
  const lead = (o: object = {}) => ({ id: "L1", full_name: null, email: null, phone: null, country: null, city: null, answers: ITALIAN, ...o })
  it("fills only what is empty", () => {
    expect(planLeadBackfill(lead())).toEqual({ fullName: "Fabrizio Sacchi", email: "fabrizio.sacchi@outlook.com", phone: "+40757906127" })
    expect(planLeadBackfill(lead({ full_name: "Someone Typed" }))).toEqual({ email: "fabrizio.sacchi@outlook.com", phone: "+40757906127" })
    expect(planLeadBackfill(lead({ full_name: "A", email: "b@c.de", phone: "+1" }))).toBeNull()
  })
  it("no answers, nothing to fill", () => {
    expect(planLeadBackfill(lead({ answers: null }))).toBeNull()
    expect(planLeadBackfill(lead({ answers: [] }))).toBeNull()
  })
})

describe("runContactBackfill", () => {
  function setup() {
    const db = new FakeDb()
    const L = db.rows("marketing_leads")
    L.push({ id: "a", full_name: null, email: null, phone: null, country: null, city: null, answers: ITALIAN, received_at: "1" })
    L.push({ id: "b", full_name: null, email: null, phone: null, country: null, city: null, answers: answers({ nome_e_cognome: "<test lead: dummy data for nome_e_cognome>" }), received_at: "2" })
    L.push({ id: "c", full_name: "Already Named", email: null, phone: null, country: null, city: null, answers: ITALIAN, received_at: "3" })
    L.push({ id: "d", full_name: null, email: null, phone: null, country: null, city: null, answers: answers({ "che_attività_hai?": "x" }), received_at: "4" })
    db.rows("contacts").push({ id: "c1", email: "fabrizio.sacchi@outlook.com", email_2: null, phone: "+40 757 906 127", phone_2: null })
    return db
  }
  it("a dry run only counts and changes nothing", async () => {
    const db = setup()
    const r = await runContactBackfill(db, { apply: false })
    expect(r).toMatchObject({ apply: false, withoutDetails: 3, filled: 2, names: 2, emails: 1, phones: 1, testLeads: 1, existingClients: 1, failed: 0 })
    expect(db.rows("marketing_leads")[0].full_name).toBeNull()
    expect(db.rows("marketing_lead_events")).toHaveLength(0)
  })
  it("applying fills the leads, flags the existing client, writes the history, and leaves the others alone", async () => {
    const db = setup()
    const r = await runContactBackfill(db, { apply: true })
    expect(r).toMatchObject({ filled: 2, failed: 0 })
    const [a, b, c, d] = db.rows("marketing_leads")
    expect(a).toMatchObject({ full_name: "Fabrizio Sacchi", email: "fabrizio.sacchi@outlook.com", phone: "+40757906127", existing_client: { contact_ids: ["c1"] } })
    expect(b).toMatchObject({ full_name: "Meta test lead", email: null })
    expect(c.email).toBeNull()                 // had a name already: not touched
    expect(d.full_name).toBeNull()             // nothing to fill from
    const kinds = db.rows("marketing_lead_events").map(e => `${e.lead_id}:${e.kind}`)
    expect(kinds).toEqual(["a:details_filled", "a:possible_existing_client", "b:details_filled"])
  })
  it("running it again changes nothing", async () => {
    const db = setup()
    await runContactBackfill(db, { apply: true })
    const events = db.rows("marketing_lead_events").length
    const r = await runContactBackfill(db, { apply: true })
    expect(r.filled).toBe(0)
    expect(db.rows("marketing_lead_events")).toHaveLength(events)
  })
  it("a failed save is counted and no history line is written for it", async () => {
    const db = setup()
    const orig = db.from.bind(db)
    db.from = (t: string) => { const q = orig(t); if (t === "marketing_leads") { const u = q.update.bind(q); q.update = (p: Record<string, unknown>) => { const r = u(p); r.then = (res: (v: { data: null; error: { message: string } }) => unknown) => Promise.resolve({ data: null, error: { message: "boom" } }).then(res); return r }; } return q }
    const r = await runContactBackfill(db, { apply: true })
    expect(r.failed).toBe(2)
    expect(db.rows("marketing_lead_events")).toHaveLength(0)
  })
  it("a lead someone filled in meanwhile is not overwritten (the update itself is guarded)", async () => {
    const db = setup()
    const orig = db.from.bind(db)
    db.from = (t: string) => {
      const q = orig(t)
      if (t === "marketing_leads") { const u = q.update.bind(q); q.update = (p: Record<string, unknown>) => { db.rows("marketing_leads")[0].full_name = "Typed By Hand"; return u(p) } }
      return q
    }
    const r = await runContactBackfill(db, { apply: true })
    expect(db.rows("marketing_leads")[0]).toMatchObject({ full_name: "Typed By Hand", email: null, phone: null })
    expect(r.failed).toBeGreaterThanOrEqual(1)
  })
})
