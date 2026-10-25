/* eslint-disable no-console */
/**
 * Security fix 2026-10-25: catalog_entries / app_settings are service-role only, and the crm-files bucket policy is an allow-list
 * (admin, team). SANDBOX only, direct database connection, everything rolled back.
 * Run: npx tsx scripts/crm-store/qa-cutover/lock-catalog-appsettings-check.ts
 */
import { config } from "dotenv"
import { Client } from "pg"
import { check, summary } from "./qa-http"
config({ path: ".env.local" })

async function main() {
  const url = process.env.SUPABASE_DB_URL ?? ""
  if (!url.includes("xjcxlmlpeywtwkhstjlw") || url.includes("ydzipybqeebtpcvsbtvs")) throw new Error("refusing to run: not the sandbox database")
  const db = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } })
  await db.connect()

  /** Run one statement as a role + JWT role claim inside a transaction that is always rolled back. Returns "ok:<rows>" or "denied:<message>". */
  async function as(role: "anon" | "authenticated" | "service_role", appRole: string | null, sql: string): Promise<string> {
    await db.query("begin")
    try {
      const claims = JSON.stringify({ sub: "00000000-0000-0000-0000-000000000001", role, app_metadata: appRole ? { role: appRole } : {} })
      await db.query("select set_config('request.jwt.claims', $1, true)", [claims])
      await db.query(`set local role ${role}`)
      const r = await db.query(sql)
      return `ok:${r.rowCount}`
    } catch (e) {
      return `denied:${(e as Error).message}`
    } finally {
      await db.query("rollback")
    }
  }

  const who: Array<[string, "anon" | "authenticated", string | null]> = [
    ["client", "authenticated", "client"],
    ["admin-role token", "authenticated", "admin"],
    ["marketing", "authenticated", "marketing"],
    ["role-less", "authenticated", null],
    ["anon key", "anon", null],
  ]
  for (const [label, role, appRole] of who) {
    for (const table of ["catalog_entries", "app_settings"]) {
      const sel = await as(role, appRole, `select * from public.${table} limit 1`)
      check(`${label} cannot SELECT ${table}`, sel.startsWith("denied") || sel === "ok:0", sel)
      const upd = await as(role, appRole, table === "app_settings" ? "update public.app_settings set value = value" : "update public.catalog_entries set display_name = display_name")
      check(`${label} cannot UPDATE ${table}`, upd.startsWith("denied") || upd === "ok:0", upd)
    }
  }
  for (const table of ["catalog_entries", "app_settings"]) {
    const sel = await as("service_role", null, `select * from public.${table} limit 1`)
    check(`service role still reads ${table}`, sel === "ok:1", sel)
  }
  const ins = (n: string) => `insert into storage.objects (bucket_id, name) values ('crm-files', 'qa-lock-check/${n}')`
  const roles: Array<[string, string | null, boolean]> = [["admin", "admin", true], ["team", "team", true], ["marketing", "marketing", false], ["client", "client", false], ["partner", "partner", false], ["role-less", null, false]]
  for (const [label, appRole, expectOk] of roles) {
    const r = await as("authenticated", appRole, ins(label))
    check(`crm-files write as ${label}: ${expectOk ? "allowed" : "refused"}`, expectOk ? r.startsWith("ok") : r.startsWith("denied"), r)
  }
  await db.end()
  summary()
}
main().catch((e) => { console.error(e); process.exit(1) })
