/* eslint-disable no-console */
/* LOCAL private stack only: creates the people for the browser walk-through of TD Marketing P1 (owner with the second step set
   up, a setter, an owner of a team that is still a draft, and a removed member). Secrets go to /tmp, never to the screen. */
import { config } from "dotenv"
config({ path: ".env.local" })
import fs from "node:fs"

if (!(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").includes("127.0.0.1")) throw new Error("local private stack only")

async function main() {
  const M = await import("@/lib/marketing/members")
  const S = await import("@/lib/marketing/settings")
  const adminActor = { kind: "admin" as const, userId: "antonio", label: "e2e-antonio", permissions: [] as string[] }
  const tokenOf = (u: string) => new URL(u).searchParams.get("token") ?? ""
  const PASS = "E2e-password-12345"
  const out: Record<string, unknown> = { password: PASS }

  {
    const { supabaseAdmin: sa } = await import("@/lib/supabase-admin")
    const adm = sa as unknown as { auth: { admin: { listUsers: (o: object) => Promise<{ data: { users: Array<{ id: string; email?: string }> } }>; deleteUser: (id: string) => Promise<unknown> } }; from: (t: string) => { delete: () => { like: (c: string, v: string) => Promise<unknown> } } }
    const old = (await adm.auth.admin.listUsers({ perPage: 1000 })).data.users.filter(u => ["rocco.mkt@example.test", "chiara.mkt@example.test", "draft.owner@example.test", "gone.mkt@example.test"].includes(u.email ?? ""))
    for (const u of old) await adm.auth.admin.deleteUser(u.id)
    await adm.from("marketing_teams").delete().like("name", "% (E2E)")
  }
  const team = (await S.createTeam({ name: "Rocco's team (E2E)", actor: "e2e" })).data!
  await S.setTeamStatus(team.id, "active", "e2e")
  const draft = (await S.createTeam({ name: "Draft team (E2E)", actor: "e2e" })).data!

  async function join(teamId: string, email: string, role: "owner" | "member", bundle: string | null, actor: Parameters<typeof M.createInvite>[0]["actor"]) {
    const inv = await M.createInvite({ teamId, email, memberRole: role, bundle, actor })
    if (inv.ok === false) throw new Error(`invite ${email}: ${inv.error}`)
    const acc = await M.acceptInvite({ token: tokenOf(inv.data!.inviteUrl), password: PASS, fullName: email.split("@")[0] })
    if (acc.ok === false) throw new Error(`accept ${email}: ${acc.error}`)
  }
  const rocco = "rocco.mkt@example.test", chiara = "chiara.mkt@example.test", drafty = "draft.owner@example.test", gone = "gone.mkt@example.test"
  await join(team.id, rocco, "owner", null, adminActor)
  const roccoActor = { kind: "owner" as const, userId: null, label: rocco, permissions: [] as string[] }
  await join(team.id, chiara, "member", "setter", roccoActor)
  await join(team.id, gone, "member", "setter", roccoActor)
  await join(draft.id, drafty, "owner", null, adminActor)

  const { supabaseAdmin } = await import("@/lib/supabase-admin")
  const a = supabaseAdmin as unknown as { auth: { admin: { listUsers: (o: object) => Promise<{ data: { users: Array<{ id: string; email?: string }> } }> } } }
  const users = (await a.auth.admin.listUsers({ perPage: 1000 })).data.users
  const idOf = (e: string) => users.find(u => u.email === e)!.id
  await M.removeMember({ teamId: team.id, userId: idOf(gone), actor: adminActor })

  // The local login service does not offer the authenticator-app second step, so the owner is given the owner-set exemption
  // (the same switch Antonio's own account uses); Chiara has NO exemption, which shows the second-step gate stopping a marketing login.
  await (supabaseAdmin as unknown as { auth: { admin: { updateUserById: (id: string, a: object) => Promise<unknown> } } }).auth.admin.updateUserById(idOf(rocco), { app_metadata: { role: "marketing", mfa_exempt: true } })

  Object.assign(out, { teamId: team.id, draftTeamId: draft.id, rocco, chiara, drafty, gone, roccoId: idOf(rocco), chiaraId: idOf(chiara) })
  fs.writeFileSync("/tmp/e2e-marketing.json", JSON.stringify(out, null, 1))
  console.log("seeded:", { rocco, chiara, drafty, gone, password: PASS, team: team.id })
}
main().catch(e => { console.error(e); process.exit(1) })
