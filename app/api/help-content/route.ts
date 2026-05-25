/**
 * Help content — the inline "i" blurbs, keyed by help_key (catalog_entries,
 * catalog_id='help_content'). Returns the WHOLE active set as a map so the
 * HelpProvider fetches once per session and every <HelpDot> reads from memory
 * (no per-dot request). STAFF-ONLY — help is internal, never shown to clients.
 * See sysdoc help-system-plan.
 */

import { NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { isDashboardUser } from "@/lib/auth"
import { listEntries } from "@/lib/catalog/framework"

export const dynamic = "force-dynamic"

export interface HelpEntry {
  title: string
  what: string
  on_click: string
  next: string
  area: string
}

export async function GET() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isDashboardUser(user)) {
    return NextResponse.json({ error: "Not authorized" }, { status: 403 })
  }

  try {
    const entries = await listEntries("help_content", {})
    const map: Record<string, HelpEntry> = {}
    for (const e of entries) {
      const m = (e.metadata ?? {}) as Record<string, unknown>
      map[e.slug] = {
        title: e.display_name,
        what: typeof m.what === "string" ? m.what : "",
        on_click: typeof m.on_click === "string" ? m.on_click : "",
        next: typeof m.next === "string" ? m.next : "",
        area: typeof m.area === "string" ? m.area : "",
      }
    }
    return NextResponse.json({ entries: map })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
