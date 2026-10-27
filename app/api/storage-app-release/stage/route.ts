/**
 * POST /api/storage-app-release/stage — the build machine puts a signed new app version in the CRM, PAUSED (never offered). Bearer token (lib/storage-app/stage-token.ts).
 *   { action: "prepare", version, build, length }  → { path, token, supabaseUrl, anonKey }  (a one-time address to upload the zip to)
 *   { action: "finish", package }                  → { ok, version, build, enabled:false }  (checks size + signature + build number, stores it paused)
 * Public path (exact, STORAGE_APP_RELEASE_PUBLIC_PATHS) — it authenticates itself, fails closed.
 */
export const dynamic = "force-dynamic"
import { NextRequest, NextResponse } from "next/server"
import { requireStageToken } from "@/lib/storage-app/stage-token"
import { loadRelease } from "@/lib/storage-app/release"
import { acceptUpload, parseReleasePackage, prepareUpload } from "@/lib/storage-app/release-publish"

export async function POST(req: NextRequest) {
  const denied = await requireStageToken(req)
  if (denied) return denied
  const b = (await req.json().catch(() => ({}))) as Record<string, unknown>
  const noStore = { "Cache-Control": "no-store" }
  if (b.action === "prepare") {
    const r = await prepareUpload(b)
    if ("error" in r) return NextResponse.json({ error: r.error }, { status: r.status })
    return NextResponse.json({ path: r.path, token: r.token, supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL, anonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY }, { headers: noStore })
  }
  if (b.action === "finish") {
    const pkg = parseReleasePackage(b.package)
    if (!pkg) return NextResponse.json({ error: "That is not a TD Storage release package." }, { status: 400 })
    try {
      const rel = await acceptUpload(pkg, await loadRelease(), "build machine")
      return NextResponse.json({ ok: true, version: rel.version, build: rel.build, enabled: rel.enabled }, { headers: noStore })
    } catch (e) {
      return NextResponse.json({ error: e instanceof Error && e.message ? e.message : "Could not store the version. Try again." }, { status: 422 })
    }
  }
  return NextResponse.json({ error: "Unknown action." }, { status: 400 })
}
