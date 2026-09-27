/**
 * GET /api/crm-store/browse/identical?sha=<sha256> — live files whose current copy has exactly these bytes
 * (the "this exact file is already stored" question). Staff only; a private area only for its own login.
 */
export const dynamic = "force-dynamic"

import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { denyUnlessStoreStaff } from "../_auth"

export async function GET(req: NextRequest) {
  const denied = await denyUnlessStoreStaff()
  if (denied) return denied
  const sha = (req.nextUrl.searchParams.get("sha") ?? "").toLowerCase()
  const { data: { user } } = await createClient().auth.getUser()
  try {
    const { findIdenticalFiles } = await import("@/lib/crm-store/structure")
    return NextResponse.json({ files: await findIdenticalFiles(sha, user?.id ?? null) }, { headers: { "Cache-Control": "no-store" } })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Could not look for the same file." }, { status: 400 })
  }
}
