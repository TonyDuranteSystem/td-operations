/* eslint-disable no-console */
/* LOCAL private stack only: proves invites, removal, pausing and the permission rules against the REAL database and login
   service (TD Marketing P1, dev job 9aec66fa). */
import { config } from "dotenv"
config({ path: ".env.local" })
import { Client } from "pg"

async function main() {
  const url = process.env.SUPABASE_DB_URL ?? ""
  const api = process.env.NEXT_PUBLIC_SUPABASE_URL ?? ""
  if (!api.includes("127.0.0.1") || !url.includes("127.0.0.1")) throw new Error("local private stack only")
  const db = new Client({ connectionString: url })
  await db.connect()
  let pass = 0, fail = 0
  const ck = (id: string, ok: boolean, note?: unknown) => { if (ok) pass++; else fail++; console.log(ok ? "PASS" : "FAIL", id, ok ? "" : JSON.stringify(note)) }
  const M = await import("@/lib/marketing/members")
  const S = await import("@/lib/marketing/settings")
  const { supabaseAdmin } = await import("@/lib/supabase-admin")
  const admin = supabaseAdmin as unknown as { auth: { admin: { createUser: (a: object) => Promise<{ data: { user: { id: string } | null }; error: unknown }>; getUserById: (id: string) => Promise<{ data: { user: { id: string; email?: string; banned_until?: string | null; app_metadata?: { role?: string } } | null } }>; deleteUser: (id: string) => Promise<unknown> } } }
  const stamp = Date.now()
  const adminActor = { kind: "admin" as const, userId: "antonio-admin-id", label: "qa-antonio", permissions: [] as string[] }
  const tokenOf = (u: string) => new URL(u).searchParams.get("token") ?? ""
  const created: string[] = []

  const team = (await S.createTeam({ name: `QA members ${stamp}`, actor: "qa" })).data!
  await S.setTeamStatus(team.id, "active", "qa")

  // 1. Antonio invites the OWNER; only he can
  const ownerEmail = `qa-owner-${stamp}@example.test`
  const ownerInvite = await M.createInvite({ teamId: team.id, email: ownerEmail, memberRole: "owner", actor: adminActor })
  ck("1 Antonio can invite a team owner", ownerInvite.ok === true, ownerInvite)
  const notAdmin = await M.createInvite({ teamId: team.id, email: `x-${stamp}@example.test`, memberRole: "owner", actor: { kind: "owner", userId: "u", label: "o", permissions: [] } })
  ck("2 an owner cannot invite another owner", notAdmin.ok === false, notAdmin)
  ck("3 the link carries a token and the database stores only a hash", /token=[A-Za-z0-9_-]{40,}/.test(ownerInvite.data!.inviteUrl) && (await db.query("select count(*) from marketing_invites where token_hash = $1", [tokenOf(ownerInvite.data!.inviteUrl)])).rows[0].count === "0")

  // 4. accept: weak password refused; good one creates a marketing login
  const weak = await M.acceptInvite({ token: tokenOf(ownerInvite.data!.inviteUrl), password: "short" })
  ck("4 a short password is refused and the invite stays usable", weak.ok === false && (await db.query("select used_at from marketing_invites where email_lower=$1", [ownerEmail])).rows[0].used_at === null, weak)
  const acc = await M.acceptInvite({ token: tokenOf(ownerInvite.data!.inviteUrl), password: "Correct-horse-battery-1", fullName: "QA Owner" })
  ck("5 accepting creates the login", acc.ok === true, acc)
  const ownerRow = (await db.query("select m.user_id, m.member_role, m.status from marketing_team_members m join auth.users u on u.id=m.user_id where u.email=$1", [ownerEmail])).rows[0]
  created.push(ownerRow?.user_id)
  const ownerUser = (await admin.auth.admin.getUserById(ownerRow.user_id)).data.user
  ck("6 the login has role 'marketing' and the team row says owner", ownerUser?.app_metadata?.role === "marketing" && ownerRow.member_role === "owner", { ownerRow, role: ownerUser?.app_metadata })
  const reuse = await M.acceptInvite({ token: tokenOf(ownerInvite.data!.inviteUrl), password: "Another-good-password-9" })
  ck("7 the same link cannot be used twice", reuse.ok === false, reuse)

  // 8. collision with an EXISTING login: generic answer, the existing login is untouched
  const exEmail = `qa-existing-${stamp}@example.test`
  const existing = await admin.auth.admin.createUser({ email: exEmail, password: "Original-password-123", email_confirm: true, app_metadata: { role: "client" } })
  created.push(existing.data.user!.id)
  const ownerActor = { kind: "owner" as const, userId: ownerRow.user_id, label: ownerEmail, permissions: [] as string[] }
  const colInvite = await M.createInvite({ teamId: team.id, email: exEmail, bundle: "setter", actor: ownerActor })
  ck("8 Rocco can invite a setter", colInvite.ok === true, colInvite)
  const col = await M.acceptInvite({ token: tokenOf(colInvite.data!.inviteUrl), password: "Attacker-chosen-pass-1" })
  const after = (await admin.auth.admin.getUserById(existing.data.user!.id)).data.user
  ck("9 an invite for an email that already has a login gives the generic answer and changes nothing", col.ok === false && col.error === "This invitation cannot be used. Ask the person who sent it for a new one." && after?.app_metadata?.role === "client", { col, role: after?.app_metadata })
  ck("10 that existing login was NOT added to the team", (await db.query("select count(*) from marketing_team_members where user_id=$1", [existing.data.user!.id])).rows[0].count === "0")

  // 11. expiry
  const expEmail = `qa-expired-${stamp}@example.test`
  const expInv = await M.createInvite({ teamId: team.id, email: expEmail, bundle: "setter", actor: ownerActor })
  await db.query("update marketing_invites set expires_at = now() - interval '1 minute' where email_lower=$1", [expEmail])
  ck("11 an expired invite is refused", (await M.acceptInvite({ token: tokenOf(expInv.data!.inviteUrl), password: "Long-enough-password-1" })).ok === false)
  ck("12 a made-up token is refused", (await M.acceptInvite({ token: "A".repeat(43), password: "Long-enough-password-1" })).ok === false)

  // 13. a real setter joins
  const setterEmail = `qa-setter-${stamp}@example.test`
  const sInv = await M.createInvite({ teamId: team.id, email: setterEmail, bundle: "setter", actor: ownerActor })
  const sAcc = await M.acceptInvite({ token: tokenOf(sInv.data!.inviteUrl), password: "Setter-password-12345" })
  const setterId = (await db.query("select m.user_id from marketing_team_members m join auth.users u on u.id=m.user_id where u.email=$1", [setterEmail])).rows[0]?.user_id
  created.push(setterId)
  ck("13 a setter joins with the setter bundle", sAcc.ok === true && !!setterId, sAcc)
  const setterActor = { kind: "member" as const, userId: setterId, label: setterEmail, permissions: ["leads.read", "leads.call", "leads.mark", "whatsapp", "chat", "inbox"] }

  // 14-18 rules
  ck("14 a setter cannot invite anyone", (await M.createInvite({ teamId: team.id, email: `y-${stamp}@example.test`, bundle: "setter", actor: setterActor })).ok === false)
  ck("15 an unknown role is refused", (await M.createInvite({ teamId: team.id, email: `z-${stamp}@example.test`, bundle: "nonexistent", actor: ownerActor })).ok === false)
  ck("16 an unknown permission is refused", (await M.createInvite({ teamId: team.id, email: `w-${stamp}@example.test`, bundle: "setter", permissions: ["root.everything"], actor: ownerActor })).ok === false)
  ck("17 the owner cannot remove or pause himself", (await M.removeMember({ teamId: team.id, userId: ownerRow.user_id, actor: ownerActor })).ok === false && (await M.setMemberPaused({ teamId: team.id, userId: ownerRow.user_id, paused: true, actor: ownerActor })).ok === false)
  ck("18 a setter cannot change his own access or remove anyone", (await M.updateMemberAccess({ teamId: team.id, userId: setterId, bundle: "seller", actor: setterActor })).ok === false && (await M.removeMember({ teamId: team.id, userId: ownerRow.user_id, actor: setterActor })).ok === false)

  // 19-22 pause, access, remove
  const pause = await M.setMemberPaused({ teamId: team.id, userId: setterId, paused: true, actor: ownerActor })
  ck("19 the owner can pause a setter (takes effect on the next request)", pause.ok === true && (await db.query("select status from marketing_team_members where user_id=$1", [setterId])).rows[0].status === "paused", pause)
  await M.setMemberPaused({ teamId: team.id, userId: setterId, paused: false, actor: ownerActor })
  const access = await M.updateMemberAccess({ teamId: team.id, userId: setterId, permissions: ["money.read"], actor: ownerActor })
  ck("20 the owner can add a permission to a setter", access.ok === true && (await db.query("select permissions from marketing_team_members where user_id=$1", [setterId])).rows[0].permissions.includes("money.read"), access)
  await S.setMarketingSetting({ key: "member_permission_ceiling", value: ["chat", "leads.read"], actor: "qa", teamId: team.id })
  ck("21 a ceiling Antonio sets caps what the owner can give", (await M.updateMemberAccess({ teamId: team.id, userId: setterId, permissions: ["money.read"], actor: ownerActor })).ok === false)
  await S.setMarketingSetting({ key: "member_permission_ceiling", value: [], actor: "qa", teamId: team.id })
  const rm = await M.removeMember({ teamId: team.id, userId: setterId, actor: ownerActor })
  const banned = (await admin.auth.admin.getUserById(setterId)).data.user
  const row = (await db.query("select status, token_version, removed_by from marketing_team_members where user_id=$1", [setterId])).rows[0]
  ck("22 removing a person marks him removed, bumps the token version and bans the login", rm.ok === true && row.status === "removed" && row.token_version === 2 && !!banned?.banned_until && new Date(banned.banned_until) > new Date(), { row, banned: banned?.banned_until })
  ck("23 only Antonio can remove an owner", (await M.removeMember({ teamId: team.id, userId: ownerRow.user_id, actor: { kind: "member", userId: "x", label: "x", permissions: ["team.manage"] } })).ok === false)
  ck("24 Antonio can pause an owner (kill switch on one person)", (await M.setMemberPaused({ teamId: team.id, userId: ownerRow.user_id, paused: true, actor: adminActor })).ok === true)

  // 25. rate limit
  let limited = false
  for (let i = 0; i < 24 && !limited; i++) {
    const r = await M.createInvite({ teamId: team.id, email: `bulk-${stamp}-${i}@example.test`, bundle: "setter", actor: ownerActor })
    if (r.ok === false && /Too many/.test(r.error ?? "")) limited = true
  }
  ck("25 invitations are rate-limited per person per hour", limited)

  // clean up logins and the team
  for (const id of created.filter(Boolean)) await admin.auth.admin.deleteUser(id).catch(() => undefined)
  await db.query("delete from marketing_teams where id=$1", [team.id])
  console.log(`\n${pass} pass, ${fail} fail`)
  await db.end()
  process.exit(fail ? 1 : 0)
}
main().catch(e => { console.error(e); process.exit(1) })
