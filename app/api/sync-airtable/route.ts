import { NextRequest, NextResponse } from "next/server"
import { syncSupabaseToAirtable } from "@/lib/sync-airtable"
import { logCron } from "@/lib/cron-log"

export const maxDuration = 120

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization")
  const cronSecret = process.env.CRON_SECRET

  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const start = Date.now()
  try {
    const stats = await syncSupabaseToAirtable()
    logCron({ endpoint: '/api/sync-airtable', status: 'success', duration_ms: Date.now() - start, details: stats as unknown as Record<string, unknown> })

    return NextResponse.json({
      success: true,
      ...stats,
      timestamp: new Date().toISOString(),
    })
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    logCron({ endpoint: '/api/sync-airtable', status: 'error', duration_ms: Date.now() - start, error_message: msg })
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
