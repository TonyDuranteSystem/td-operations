/**
 * Email open tracking pixel endpoint.
 * Serves a 1x1 transparent GIF and records the open in email_tracking table.
 * URL format: /api/track/open/{tracking_id}
 */

import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"

// 1x1 transparent GIF (43 bytes)
const PIXEL = Buffer.from(
  "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
  "base64"
)

// Use service role to bypass RLS
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: trackingId } = await params

  // Fire-and-forget: atomically increment open count
  try {
    await supabase.rpc("increment_email_open", { p_tracking_id: trackingId })
  } catch {
    // Silently fail — don't break the pixel response
  }

  // Return 1x1 transparent GIF with cache-busting headers
  return new NextResponse(PIXEL, {
    status: 200,
    headers: {
      "Content-Type": "image/gif",
      "Content-Length": String(PIXEL.length),
      "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
      Pragma: "no-cache",
      Expires: "0",
    },
  })
}
