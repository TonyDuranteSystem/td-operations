export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from "next/server"
import { matchAndReconcile } from "@/lib/bank-feed-matcher"

export async function GET(req: NextRequest) {
  const feedId = req.nextUrl.searchParams.get("feedId")
  if (!feedId) return NextResponse.json({ error: "feedId required" }, { status: 400 })

  const secret = req.headers.get("authorization")
  if (secret !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  try {
    const result = await matchAndReconcile(feedId)
    return NextResponse.json({ result })
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message, stack: (err as Error).stack }, { status: 500 })
  }
}
