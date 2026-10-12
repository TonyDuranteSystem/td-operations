/* eslint-disable no-console */
/** Writes a throw-away SANDBOX staff session cookie (as name=value pairs) to a private scratch file for the browser check. */
import { writeFileSync, chmodSync } from "fs"
import { sessionCookie, type QaUser } from "./qa-http"

async function main() {
  const who = (process.argv[2] ?? "staff") as QaUser
  const cookie = await sessionCookie(who)
  const out = `/private/tmp/claude-501/scratch/qa-cookie-${who}.json`
  writeFileSync(out, JSON.stringify(cookie.split("; ").map((p) => ({ name: p.slice(0, p.indexOf("=")), value: p.slice(p.indexOf("=") + 1) }))))
  chmodSync(out, 0o600)
  console.log("written", out)
}
main().catch((e) => { console.error(e); process.exit(1) })
