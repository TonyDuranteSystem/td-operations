import { NextRequest, NextResponse } from "next/server"

// Backwards-compat: the referral landing page moved from /r/[code] to
// /invitation/[code]. Any previously shared /r/ link 308-redirects to the new
// path (preserving query params), so old links keep working (R015).
export async function GET(req: NextRequest, { params }: { params: Promise<{ code: string }> }) {
  const { code } = await params
  const url = new URL(`/invitation/${code}`, req.url)
  url.search = req.nextUrl.search
  return NextResponse.redirect(url, 308)
}
