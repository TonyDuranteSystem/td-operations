/**
 * POST /api/system-errors/update — resolve/ignore/reopen an error from the
 * /system-health panel. CRM staff only (clients get 403).
 */

import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { updateSystemErrorStatus, type SystemErrorStatus } from "@/lib/system-errors"

const ALLOWED: SystemErrorStatus[] = ["open", "resolved", "ignored"]

export async function POST(req: NextRequest) {
  try {
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user || user.app_metadata?.role === "client") {
      return NextResponse.json({ error: "Staff access required" }, { status: 403 })
    }

    const body = await req.json().catch(() => null)
    const id = body?.id
    const status = body?.status
    if (typeof id !== "string" || !ALLOWED.includes(status)) {
      return NextResponse.json({ error: "id and a valid status (open/resolved/ignored) are required" }, { status: 400 })
    }

    const ok = await updateSystemErrorStatus(id, status)
    if (!ok) {
      return NextResponse.json({ error: "Update failed" }, { status: 500 })
    }
    return NextResponse.json({ success: true })
  } catch (err) {
    console.error("[system-errors/update] failed:", err)
    return NextResponse.json({ error: "Update failed" }, { status: 500 })
  }
}
