/* eslint-disable no-console */
/* SANDBOX only (TD Social, dev job 2072bc3e, App Store review, 6 Nov 2026): makes the PRACTICE login Apple's reviewer signs in with: a throw-away TD Marketing team
   "Review Demo Team" with two people (a team owner to talk with, and a chat-only member = the login the reviewer uses) and ONLY invented content (invented people, phone numbers on the
   555 range, invented chat messages). Nothing here is a real client or a real conversation. Everything it makes carries the exact team name / exact addresses below, so `--clean`
   removes exactly that and nothing else. The password goes to a 0600 file (default /tmp/review-demo-login.json, or DEMO_OUT), never to the screen.
   Run: npx tsx scripts/marketing/apple-review-demo.ts            (make)      npx tsx scripts/marketing/apple-review-demo.ts --clean   (remove)
        npx tsx scripts/marketing/apple-review-demo.ts --rearm         (only moves the reviewer login's deadline forward: same login, same password, same content)
   The team OWNER here is only the author of the invented messages. It gets its own random password that is never written down and is BANNED at once, so nobody holding the reviewer's password can use it
   (an owner with no authenticator would be sent to enrol one and could then act as the team owner).
   The invented content is plain data (`buildDemoContent`), so the SAME rows can be put on production later (only on Antonio's word, by hand: this script refuses anything but the sandbox). */
import { config } from "dotenv"
config({ path: ".env.local" })
import fs from "node:fs"
import crypto from "node:crypto"

const DEMO_TEAM = "Review Demo Team"
const OWNER_EMAIL = process.env.DEMO_OWNER_EMAIL ?? "review-demo-owner@example.test"
const SETTER_EMAIL = process.env.DEMO_SETTER_EMAIL ?? "review-demo-setter@example.test"
const OUT = process.env.DEMO_OUT ?? "/tmp/review-demo-login.json"

type Person = { id: string; name: string }
type Content = {
  leads: Array<Record<string, unknown>>
  leadMessages: Array<Record<string, unknown>>
  threads: Array<Record<string, unknown>>
  threadMembers: Array<Record<string, unknown>>
  teamMessages: Array<Record<string, unknown>>
}

/** The invented content, as plain rows. Pure: no database, no clock beyond the `now` it is given, so it can be read, tested and reused. */
function buildDemoContent(teamId: string, owner: Person, setter: Person, now: number): Content {
  const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString()
  // the leads are dated a year back on purpose: the CRM master list shows every team's leads newest first, and invented ones must sink to the bottom, away from the real ones (the chats keep recent dates)
  const OLD = 365 * 24 * 60
  const lead = (n: number, name: string, city: string, status: string, receivedMinAgo: number, extra: Record<string, unknown> = {}) => ({
    id: crypto.randomUUID(), team_id: teamId, leadgen_id: `review-demo-${n}`, source: "review_demo", platform: "fb", campaign_name: "Spring practice campaign",
    full_name: name, email: `${name.toLowerCase().replace(/[^a-z]+/g, ".")}@example.test`, phone: `+1 555 010 01${String(n).padStart(2, "0")}`, country: "IT", city,
    status, received_at: ago(receivedMinAgo), updated_at: ago(receivedMinAgo), ...extra,
  })
  const leads = [
    lead(1, "Marco Bianchi", "Milan", "qualified", OLD + 60 * 30),
    lead(2, "Giulia Ferri", "Rome", "new", OLD + 60 * 5),
    lead(3, "Luca Moretti", "Turin", "contacted", OLD + 60 * 52),
    lead(4, "Sofia Romano", "Naples", "qualified", OLD + 60 * 20),
    lead(5, "Paolo Greco", "Bologna", "not_in_target", OLD + 60 * 70, { not_in_target_reason: "Not planning to open a US company" }),
    lead(6, "Elena Conti", "Florence", "new", OLD + 60 * 2),
  ]
  const L = (i: number) => leads[i].id as string
  const lm = (lead: string, from: Person, message: string, minutesAgo: number) => ({
    id: crypto.randomUUID(), team_id: teamId, lead_id: lead, sender_id: from.id, sender_name: from.name, message, lane: "setter", created_at: ago(minutesAgo),
  })
  const leadMessages = [
    lm(L(0), setter, "Marco filled the form yesterday. He wants a US LLC for his online shop and asked about the price.", 60 * 28),
    lm(L(0), owner, "Good lead. Please ask which state he prefers and whether he already has a business bank account.", 60 * 27),
    lm(L(0), setter, "He has no bank account yet and has no preference on the state.", 60 * 26),
    lm(L(0), owner, "Thanks, I will call him tomorrow morning.", 60 * 26 - 5),
    lm(L(2), setter, "Tried twice today, no answer. I left a voice message.", 60 * 50),
    lm(L(2), owner, "Try again after lunch. If nothing, send the short WhatsApp message.", 60 * 49),
    lm(L(3), setter, "Sofia is a freelance designer. She asked how long the process takes.", 60 * 19),
    lm(L(3), owner, "About two weeks from the signed agreement. Tell her I can explain it on a call.", 60 * 18),
    lm(L(3), setter, "She is free Thursday afternoon.", 60 * 17),
    lm(L(4), setter, "Paolo only wanted general information. He is not opening a US company.", 60 * 68),
    lm(L(5), setter, "New lead, not contacted yet.", 90),
  ]
  const groupId = crypto.randomUUID(), dmId = crypto.randomUUID()
  const threads = [
    { id: groupId, team_id: teamId, kind: "group", title: "Daily follow-up", dm_key: null, created_by: owner.id, created_at: ago(60 * 70) },
    { id: dmId, team_id: teamId, kind: "dm", title: null, dm_key: [owner.id, setter.id].sort().join(":"), created_by: setter.id, created_at: ago(60 * 40) },
  ]
  const threadMembers = [groupId, dmId].flatMap(t => [owner, setter].map(p => ({ thread_id: t, user_id: p.id, added_by: owner.id, joined_at: ago(60 * 70) })))
  const tm = (thread: string, from: Person, message: string, minutesAgo: number) => ({
    id: crypto.randomUUID(), team_id: teamId, thread_id: thread, sender_id: from.id, sender_name: from.name, message, created_at: ago(minutesAgo),
  })
  const teamMessages = [
    tm(groupId, owner, "Good morning. Today: call back the two warm leads and clear the new ones.", 60 * 6),
    tm(groupId, setter, "Morning! Three new leads came in overnight, I will start with those.", 60 * 6 - 4),
    tm(groupId, owner, "Great. Write a short note in each lead chat so we both know where it stands.", 60 * 6 - 9),
    tm(groupId, setter, "Done for the first two, doing the rest after the calls.", 60 * 3),
    tm(dmId, setter, "Can you take the call with Sofia on Thursday?", 60 * 16),
    tm(dmId, owner, "Yes, book it for 3 pm and add a note for me.", 60 * 15),
    tm(dmId, setter, "Booked. Thank you!", 60 * 15 - 3),
  ]
  return { leads, leadMessages, threads, threadMembers, teamMessages }
}

async function main() {
  // BOTH the API address and the direct database connection (the cleanup below deletes through it) must be the sandbox
  if (!(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").includes("xjcxlmlpeywtwkhstjlw")) throw new Error("sandbox only (API address)")
  if (!(process.env.SUPABASE_DB_URL ?? "").includes("xjcxlmlpeywtwkhstjlw") || (process.env.SUPABASE_DB_URL ?? "").includes("ydzipybqeebtpcvsbtvs")) throw new Error("sandbox only (database connection)")
  const { supabaseAdmin } = await import("@/lib/supabase-admin")
  const { Client } = await import("pg")
  type AuthUser = { id: string; email?: string; app_metadata?: Record<string, unknown> }
  const db = supabaseAdmin as unknown as { from: (t: string) => any; auth: { admin: { listUsers: (o: object) => Promise<{ data: { users: AuthUser[] } }>; deleteUser: (id: string) => Promise<unknown> } } }
  // every page of logins (the list is 1000 per page): the practice logins must be found wherever they are
  const users = async () => {
    const out: AuthUser[] = []
    for (let page = 1; ; page++) {
      const { data } = await db.auth.admin.listUsers({ page, perPage: 1000 })
      out.push(...data.users)
      if (data.users.length < 1000) return out
    }
  }
  const pg = new Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } })
  await pg.connect()

  const { REVIEW_DEMO_MAX_DAYS } = await import("@/lib/auth/mfa-gate")
  const days = Number(process.env.DEMO_DAYS ?? 60)
  if (!Number.isFinite(days) || days <= 0 || days > REVIEW_DEMO_MAX_DAYS) throw new Error(`DEMO_DAYS must be between 1 and ${REVIEW_DEMO_MAX_DAYS} (the sign-in gate ignores a deadline further away, and the reviewer would be stopped at the authenticator page)`)
  const untilFrom = () => new Date(Date.now() + days * 86_400_000).toISOString()
  const fromNow = () => new Date(Date.now() - 60_000).toISOString() // a minute back, so a small clock difference never makes the window "not started yet"
  type AdminAuth = { auth: { admin: { updateUserById: (id: string, a: object) => Promise<{ error: { message: string } | null }> } } }
  if (process.argv.includes("--rearm")) {
    const reviewer = (await users()).find(u => u.email === SETTER_EMAIL)
    if (!reviewer) throw new Error(`no practice reviewer login (${SETTER_EMAIL}): run the script without --rearm first`)
    const until = untilFrom()
    const boundTeam = reviewer.app_metadata?.review_demo_team
    if (typeof boundTeam !== "string" || !boundTeam) throw new Error("the reviewer login has no review_demo_team: run the script without --rearm first")
    const r = await (supabaseAdmin as unknown as AdminAuth).auth.admin.updateUserById(reviewer.id, { app_metadata: { role: "marketing", review_demo_from: fromNow(), review_demo_until: until, review_demo_team: boundTeam } })
    if (r.error) throw new Error(`rearm: ${r.error.message}`)
    console.log(`the reviewer login may use its password alone until ${until}`)
    await pg.end(); return
  }

  // clean: only this script's own rows, matched by the exact team name and the exact two addresses
  // only the two exact addresses, and only when they are example.test addresses (a real person's login is never matched, whatever DEMO_*_EMAIL says)
  if (![OWNER_EMAIL, SETTER_EMAIL].every(e => e.endsWith("@example.test"))) throw new Error("the sandbox practice logins must be @example.test addresses")
  const old = (await users()).filter(u => [OWNER_EMAIL, SETTER_EMAIL].includes(u.email ?? ""))
  const teamRows = (await pg.query("select id from marketing_teams where name = $1", [DEMO_TEAM])).rows as Array<{ id: string }>
  for (const t of teamRows) {
    const leadIds = (await pg.query("select id from marketing_leads where team_id = $1", [t.id])).rows.map(r => r.id as string)
    const threadIds = (await pg.query("select id from marketing_chat_threads where team_id = $1", [t.id])).rows.map(r => r.id as string)
    const steps: Array<[string, string, unknown[]]> = [
      ["marketing_lead_message_reactions", "message_id in (select id from marketing_lead_messages where team_id = $1)", [t.id]],
      ["marketing_team_message_reactions", "message_id in (select id from marketing_team_messages where team_id = $1)", [t.id]],
      ["marketing_lead_messages", "team_id = $1", [t.id]], ["marketing_team_messages", "team_id = $1", [t.id]],
      ["marketing_lead_chat_reads", "team_id = $1", [t.id]], ["marketing_lead_chat_delivery", "team_id = $1", [t.id]],
      ["marketing_lead_lane_reads", "team_id = $1", [t.id]], ["marketing_lead_lane_delivery", "team_id = $1", [t.id]],
      ["marketing_team_chat_reads", "team_id = $1", [t.id]], ["marketing_team_chat_delivery", "team_id = $1", [t.id]],
      ["marketing_chat_thread_members", "thread_id = any($1::uuid[])", [threadIds]], ["marketing_chat_threads", "team_id = $1", [t.id]],
      ["marketing_lead_events", "lead_id = any($1::uuid[])", [leadIds]], ["marketing_leads", "team_id = $1", [t.id]],
      ["marketing_push_subscriptions", "team_id = $1", [t.id]], ["marketing_tour_seen", "team_id = $1", [t.id]], ["marketing_news", "team_id = $1", [t.id]],
      ["marketing_settings", "team_id = $1", [t.id]], // (the settings history is append-only on purpose: its lines stay)
      ["marketing_invites", "team_id = $1", [t.id]], ["marketing_team_members", "team_id = $1", [t.id]], ["marketing_teams", "id = $1", [t.id]],
    ]
    for (const [table, where, args] of steps) await pg.query(`delete from ${table} where ${where}`, args as unknown[])
  }
  for (const u of old) await db.auth.admin.deleteUser(u.id)
  if (process.argv.includes("--clean")) { try { fs.unlinkSync(OUT) } catch { /* nothing to remove */ } console.log("cleaned"); await pg.end(); return }

  const M = await import("@/lib/marketing/members")
  const S = await import("@/lib/marketing/settings")
  const adminActor = { kind: "admin" as const, userId: "antonio", label: "review-demo", permissions: [] as string[] }
  const PASS = crypto.randomBytes(12).toString("base64url") + "-Aa1"
  const OWNER_PASS = crypto.randomBytes(24).toString("base64url") + "-Zz9" // never written anywhere: the owner login is banned below
  const team = (await S.createTeam({ name: DEMO_TEAM, actor: "review-demo" })).data!
  await S.setTeamStatus(team.id, "active", "review-demo")
  const tokenOf = (u: string) => new URL(u).searchParams.get("token") ?? ""
  async function join(email: string, fullName: string, role: "owner" | "member", bundle: string | null, actor: Parameters<typeof M.createInvite>[0]["actor"], permissions?: string[], password: string = PASS) {
    const inv = await M.createInvite({ teamId: team.id, email, memberRole: role, bundle, permissions, actor })
    if (inv.ok === false) throw new Error(`invite ${email}: ${inv.error}`)
    const acc = await M.acceptInvite({ token: tokenOf(inv.data!.inviteUrl), password, fullName })
    if (acc.ok === false) throw new Error(`accept ${email}: ${acc.error}`)
  }
  await join(OWNER_EMAIL, "Alex Demo", "owner", null, adminActor, undefined, OWNER_PASS)
  // the login Apple's reviewer uses: the smallest access that shows the app (read the leads and chat about them), no calls, no payment links, no money, no files
  await join(SETTER_EMAIL, "Sam Setter", "member", null, { kind: "owner" as const, userId: null, label: OWNER_EMAIL, permissions: [] as string[] }, ["chat", "leads.read"])
  const all = await users()
  const owner = { id: all.find(u => u.email === OWNER_EMAIL)!.id, name: "Alex Demo" }
  const setter = { id: all.find(u => u.email === SETTER_EMAIL)!.id, name: "Sam Setter" }
  await pg.query("update marketing_teams set owner_user_id = $1 where id = $2", [owner.id, team.id])
  // the reviewer's login may sign in with its password alone until this deadline (the window from -> until is at most 90 days long: the gate ignores a longer one), is capped to chat + reading leads on every request, and is TIED to this one team (the guard refuses it anywhere else)
  const until = untilFrom()
  const upd = await (supabaseAdmin as unknown as AdminAuth).auth.admin.updateUserById(setter.id, { app_metadata: { role: "marketing", review_demo_from: fromNow(), review_demo_until: until, review_demo_team: team.id } })
  if (upd.error) throw new Error(`review flag: ${upd.error.message}`)
  // the owner only AUTHORS the invented messages: nobody may ever sign in as it (no password is kept, and the login is banned for a hundred years)
  const ban = await (supabaseAdmin as unknown as AdminAuth).auth.admin.updateUserById(owner.id, { ban_duration: "876000h" } as object)
  if (ban.error) throw new Error(`ban owner: ${ban.error.message}`)

  const c = buildDemoContent(team.id, owner, setter, Date.now())
  const put = async (table: string, rows: Array<Record<string, unknown>>) => {
    const r = await db.from(table).insert(rows)
    if (r.error) throw new Error(`${table}: ${r.error.message}`)
  }
  await put("marketing_leads", c.leads)
  await put("marketing_lead_messages", c.leadMessages)
  await put("marketing_chat_threads", c.threads)
  await put("marketing_chat_thread_members", c.threadMembers)
  await put("marketing_team_messages", c.teamMessages)
  await pg.end()

  fs.writeFileSync(OUT, JSON.stringify({ environment: "sandbox", team: DEMO_TEAM, team_id: team.id, owner_email: OWNER_EMAIL, setter_email: SETTER_EMAIL, password: PASS }, null, 2), { mode: 0o600 })
  console.log(`made team "${DEMO_TEAM}" (${team.id}): ${c.leads.length} invented leads, ${c.leadMessages.length} lead messages, ${c.threads.length} conversations, ${c.teamMessages.length} team messages. Login details in ${OUT} (0600).`)
}

main().catch(e => { console.error(e); process.exit(1) })
