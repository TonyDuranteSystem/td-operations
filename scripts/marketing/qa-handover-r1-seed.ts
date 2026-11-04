/* eslint-disable no-console */
/* SANDBOX only (TD Marketing, dev job 9aec66fa, Release 1 of the 3 Nov 2026 hand-over): makes a throw-away team "Handover R1 QA (R1QA)" with a seller (the owner, who takes calls) and a setter, and six leads
   that cover the new flow and the old leftovers. Everything it makes carries "r1qa" / "(R1QA)" so `--clean` removes exactly that and nothing else. The password goes to a 0600 file in /tmp, never to the screen.
   Run: npx tsx scripts/marketing/qa-handover-r1-seed.ts            (make)      npx tsx scripts/marketing/qa-handover-r1-seed.ts --clean   (remove) */
import { config } from "dotenv"
config({ path: ".env.local" })
import fs from "node:fs"
import crypto from "node:crypto"

const TEAM = "Handover R1 QA (R1QA)"
const SELLER = "r1qa-seller@example.test", SETTER = "r1qa-setter@example.test"
const OUT = "/tmp/r1qa-handover.json"

async function main() {
  if (!(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").includes("xjcxlmlpeywtwkhstjlw")) throw new Error("sandbox only")
  const { supabaseAdmin } = await import("@/lib/supabase-admin")
  const db = supabaseAdmin as unknown as { from: (t: string) => any; auth: { admin: { listUsers: (o: object) => Promise<{ data: { users: Array<{ id: string; email?: string }> } }>; deleteUser: (id: string) => Promise<unknown>; updateUserById: (id: string, a: object) => Promise<unknown> } } } // eslint-disable-line @typescript-eslint/no-explicit-any
  const users = async () => (await db.auth.admin.listUsers({ perPage: 1000 })).data.users
  // clean: only this script's own rows, matched by exact name / exact address
  const old = (await users()).filter(u => [SELLER, SETTER].includes(u.email ?? ""))
  const teams = (await db.from("marketing_teams").select("id").eq("name", TEAM)).data as Array<{ id: string }> | null
  for (const t of teams ?? []) {
    const leads = (await db.from("marketing_leads").select("id").eq("team_id", t.id)).data as Array<{ id: string }> | null
    for (const l of leads ?? []) await db.from("marketing_lead_events").delete().eq("lead_id", l.id)
    await db.from("marketing_leads").delete().eq("team_id", t.id)
    await db.from("marketing_settings").delete().eq("team_id", t.id)
    await db.from("marketing_team_members").delete().eq("team_id", t.id)
    await db.from("marketing_teams").delete().eq("id", t.id)
  }
  for (const u of old) await db.auth.admin.deleteUser(u.id)
  try { fs.unlinkSync("/tmp/r1qa-totp.json") } catch { /* none yet */ } // the second-step secrets belonged to the deleted people
  if (process.argv.includes("--clean")) { try { fs.unlinkSync(OUT) } catch { /* nothing to remove */ } console.log("cleaned"); return }

  const M = await import("@/lib/marketing/members")
  const S = await import("@/lib/marketing/settings")
  const adminActor = { kind: "admin" as const, userId: "antonio", label: "r1qa", permissions: [] as string[] }
  const PASS = crypto.randomBytes(12).toString("base64url") + "-Aa1"
  const team = (await S.createTeam({ name: TEAM, actor: "r1qa" })).data!
  await S.setTeamStatus(team.id, "active", "r1qa")
  const tokenOf = (u: string) => new URL(u).searchParams.get("token") ?? ""
  async function join(email: string, role: "owner" | "member", bundle: string | null, actor: Parameters<typeof M.createInvite>[0]["actor"]) {
    const inv = await M.createInvite({ teamId: team.id, email, memberRole: role, bundle, actor })
    if (inv.ok === false) throw new Error(`invite ${email}: ${inv.error}`)
    const acc = await M.acceptInvite({ token: tokenOf(inv.data!.inviteUrl), password: PASS, fullName: email.split("@")[0] })
    if (acc.ok === false) throw new Error(`accept ${email}: ${acc.error}`)
  }
  await join(SELLER, "owner", null, adminActor)
  await join(SETTER, "member", "setter", { kind: "owner" as const, userId: null, label: SELLER, permissions: [] as string[] })
  const all = await users()
  const idOf = (e: string) => all.find(u => u.email === e)!.id
  for (const e of [SELLER, SETTER]) await db.auth.admin.updateUserById(idOf(e), { app_metadata: { role: "marketing", mfa_exempt: true } })
  // the seller takes calls (his hours are set), the calendar switches stay off (a typed time is used)
  const r = await S.setMarketingSetting({ key: "member_call_hours", value: { [idOf(SELLER)]: {} }, actor: "r1qa", teamId: team.id })
  if (r.ok === false) throw new Error(`call hours: ${r.error}`)

  const day = 24 * 3600_000
  const mk = (n: string, status: string, over: Record<string, unknown> = {}) => ({ team_id: team.id, leadgen_id: `r1qa-${n}-${Date.now()}`, source: "r1qa", platform: "fb", full_name: `R1QA ${n}`, email: `r1qa-${n.toLowerCase().replace(/\W+/g, "-")}@example.test`, phone: "+15550100000", country: "US", status, received_at: new Date(Date.now() - 3600_000).toISOString(), answers: [], raw: {}, ...over })
  const rows = [
    mk("Qualified A (setter will book)", "qualified"), mk("Qualified B (booking then cancel)", "qualified"),
    mk("Old booked future", "booked"), mk("Old booked past", "booked"), mk("Old seller contacted", "seller_contacted"), mk("New C", "new"),
  ]
  const ins = await db.from("marketing_leads").insert(rows).select("id, full_name, status")
  if (ins.error) throw new Error(`leads: ${ins.error.message}`)
  const byName = Object.fromEntries((ins.data as Array<{ id: string; full_name: string }>).map(l => [l.full_name, l.id]))
  const ev = (lead: string, kind: string, data: Record<string, unknown>, ago = 0) => ({ lead_id: byName[lead], kind, actor: SETTER, data, created_at: new Date(Date.now() - ago).toISOString() })
  const e = await db.from("marketing_lead_events").insert([
    ev("R1QA Old booked future", "appointment", { at: new Date(Date.now() + 2 * day).toISOString(), note: "old future call" }, 3600_000),
    ev("R1QA Old booked past", "appointment", { at: new Date(Date.now() - 2 * day).toISOString(), note: "old past call" }, 4 * day),
  ])
  if (e.error) throw new Error(`events: ${e.error.message}`)
  fs.writeFileSync(OUT, JSON.stringify({ password: PASS, teamId: team.id, seller: SELLER, setter: SETTER, sellerId: idOf(SELLER), leads: byName }, null, 1), { mode: 0o600 })
  console.log("seeded", { teamId: team.id, seller: SELLER, setter: SETTER, leads: Object.keys(byName).length, secretsFile: OUT })
}
main().catch(e => { console.error(e); process.exit(1) })
