/**
 * Every /api/storage-app route starts here (dev job 1992a087). FAIL CLOSED: no valid device token → 401, whatever else is
 * present. The browser cookie is NEVER read on these routes (so a logged-in staff browser cannot be driven cross-site against
 * them), and the token is accepted ONLY here (the cookie, cron and MCP paths do not know it).
 */
import { NextRequest, NextResponse } from "next/server"
import { bearerFrom } from "./tokens"
import { verifyAccessToken, type DeviceCaller } from "./device-auth"
import { denyUnlessStoreStaff } from "@/app/api/crm-store/browse/_auth"

const NO_STORE = { "Cache-Control": "no-store" }

export const unauthorized = () => NextResponse.json({ error: "Not signed in." }, { status: 401, headers: NO_STORE })
export const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: NO_STORE })

export async function withDevice(req: NextRequest, handler: (caller: DeviceCaller) => Promise<NextResponse>): Promise<NextResponse> {
  const token = bearerFrom(req.headers.get("authorization"))
  if (!token) return unauthorized()
  const ip = req.headers.get("x-forwarded-for")
  const caller = await verifyAccessToken(token, ip)
  if (!caller) return unauthorized()
  const denied = await denyUnlessStoreStaff(caller.user)   // the same staff check as the Storage page, belt and braces
  if (denied) return denied
  try {
    return await handler(caller)
  } catch (e) {
    console.error("[storage-app]", e instanceof Error ? e.message : e)   // the detail stays in our log, never in the answer
    return json({ error: "Something went wrong. Please try again." }, 500)
  }
}
