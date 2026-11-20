/**
 * Guard for the member "no portal access" mark (dev job beb43385, delivery A).
 *
 * A person's link to a company (account_contacts) can carry `access_revoked_at`: the person is still an owner
 * (membership is a legal fact) but the company is NOT open to them in the portal and they are not told things
 * about it. Every place that reads those links to decide who can OPEN a company, or who is TOLD about one, must
 * leave out a link that carries the mark.
 *
 * This test reads the portal-facing source and fails when a read of account_contacts neither filters on the mark
 * nor says, on the line above it, why it is allowed to see every link:
 *
 *     // portal-access-ok: <reason>
 *
 * A reason is for roster questions (legal documents, ownership, per-person dates) and for the creation paths that
 * later deliveries change. It is NOT for "I did not want to deal with it": a new reader that decides who sees or is
 * told about a company must carry the filter.
 */
import { describe, it, expect } from "vitest"
import fs from "node:fs"
import path from "node:path"

const ROOT = path.resolve(__dirname, "..", "..")

// The portal-facing code: client pages, client APIs, the portal library, the tier sync.
const SCAN: string[] = [
  "app/portal",
  "app/api/portal",
  "lib/portal",
  "lib/portal-auth.ts",
  "lib/td-communication",
  "lib/operations/sync-tier.ts",
  "lib/storage-app",
  "lib/portal-app",
]

// Senders and creators OUTSIDE the portal folders that choose WHO we write to, or who gets a login (dev job beb43385, delivery C).
// A person with the mark is never picked as the recipient. These files are read by the same rule as the portal code.
const FAN_OUT_FILES: string[] = [
  "lib/jobs/handlers/welcome-package-setup.ts",
  "lib/mcp/tools/welcome-package.ts",
  "app/api/cron/annual-renewal-msa/route.ts",
  "lib/operations/service-start-notice.ts",
  "lib/tasks/workflow-handlers/chain-send-client-message.ts",
  "lib/tasks/workflow-handlers/task-waiting-with-optional-message.ts",
  "app/api/cron/itin-processing-check/route.ts",
  "lib/operations/referral-notify.ts",
  "lib/operations/signature.ts",
  "lib/offers/process-agreement-signed.ts",
  "app/api/portal/admin/create-user/route.ts",
  "lib/mcp/tools/portal.ts",
  "lib/members/portal-access-refusal.ts",
  "lib/members/staff-portal-access.ts",
]

// Files that read every link on purpose, with the reason. (None now: the staff "create a portal login" route was the
// last one; delivery C made it refuse a member who has no portal access.)
const ALLOWED_FILES: Record<string, string> = {}

const FROM = /\.from\((['"])account_contacts\1\)/
const WRITE = /\.(insert|upsert|update|delete)\(/

function walk(rel: string, out: string[]) {
  const abs = path.join(ROOT, rel)
  if (!fs.existsSync(abs)) return
  const st = fs.statSync(abs)
  if (st.isFile()) {
    if (/\.(ts|tsx)$/.test(abs)) out.push(rel)
    return
  }
  for (const name of fs.readdirSync(abs)) {
    if (name === "node_modules" || name === ".next") continue
    walk(path.join(rel, name), out)
  }
}

describe("portal link access guard", () => {
  it("every read of account_contacts in portal-facing code filters on the mark or says why not", () => {
    const files: string[] = []
    for (const s of SCAN) walk(s, files)
    expect(files.length).toBeGreaterThan(50) // the scan really found the portal code
    for (const f of FAN_OUT_FILES) {
      expect(fs.existsSync(path.join(ROOT, f)), `${f} is on the fan-out list but does not exist`).toBe(true)
      if (!files.includes(f)) files.push(f)
    }

    const offenders: string[] = []
    let reads = 0
    for (const rel of files) {
      if (ALLOWED_FILES[rel]) continue
      const lines = fs.readFileSync(path.join(ROOT, rel), "utf8").split("\n")
      lines.forEach((line, i) => {
        if (!FROM.test(line)) return
        if (/^\s*(\*|\/\/)/.test(line)) return // a comment that mentions it
        const head = lines.slice(i, i + 4).join("\n")
        if (WRITE.test(head)) return // a write is not a visibility check
        reads++
        const window = lines.slice(Math.max(0, i - 2), i + 8).join("\n")
        if (window.includes("access_revoked_at") || window.includes("portal-access-ok")) return
        offenders.push(`${rel}:${i + 1}`)
      })
    }
    expect(reads).toBeGreaterThan(40)
    expect(offenders, `These reads of account_contacts ignore the no-access mark:\n${offenders.join("\n")}`).toEqual([])
  })
})
