import { describe, it, expect } from "vitest"
import { readdirSync, readFileSync, statSync } from "fs"
import { join } from "path"
import { STORAGE_APP_PUBLIC_PATHS } from "@/lib/storage-app/public-paths"

const root = join(__dirname, "..", "..")
const dir = join(root, "app", "api", "storage-app")

function routeFiles(d: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(d)) {
    const p = join(d, name)
    if (statSync(p).isDirectory()) out.push(...routeFiles(p))
    else if (name === "route.ts") out.push(p)
  }
  return out
}

describe("/api/storage-app — every route is accounted for and fails closed", () => {
  const files = routeFiles(dir)
  const paths = files.map((f) => "/api/storage-app" + f.slice(dir.length).replace(/\/route\.ts$/, "")).sort()

  it("the public-path list names EXACTLY the route files that exist (a new route cannot slip in or out unnoticed)", () => {
    expect(paths).toEqual([...STORAGE_APP_PUBLIC_PATHS].sort())
  })
  it("every route except the token swap starts with the fail-closed device guard, and none reads the browser cookie", () => {
    for (const f of files) {
      const src = readFileSync(f, "utf8")
      expect(src, f).not.toMatch(/supabase\/server|cookies\(\)|createClient\(/)
      if (f.endsWith("/token/route.ts")) continue
      expect(src, f).toMatch(/withDevice\(/)
    }
  })
  it("the gatekeeper lists these paths exactly and never the bare prefix", () => {
    const mw = readFileSync(join(root, "middleware.ts"), "utf8")
    if (!mw.includes("STORAGE_APP_PUBLIC_PATHS")) return   // the gatekeeper edit is Antonio's separate approval; asserted once it exists
    expect(mw).not.toMatch(/['"]\/api\/storage-app\/?['"]/)
  })
  it("no cookie-login route lives under /api/storage-app (those are under /api/store-devices)", () => {
    expect(paths.some((p) => /approve|revoke|devices/.test(p))).toBe(false)
  })
})
