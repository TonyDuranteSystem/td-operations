/**
 * /storage-app/approve — where a staff member approves the TD Storage Mac app (dev job 1992a087). The app opens this page in the
 * browser; the page is behind the normal CRM login and two-step login (it is not a public path). The approval itself is
 * POST /api/store-devices/approve.
 */
import { checkCode, cleanDeviceName, isValidChallenge, isValidLoopbackRedirect } from "@/lib/storage-app/tokens"
import { ApproveDevice } from "./approve-device"

export const dynamic = "force-dynamic"

export default function ApproveStorageAppPage({ searchParams }: { searchParams: Record<string, string | string[] | undefined> }) {
  const one = (k: string) => (typeof searchParams[k] === "string" ? (searchParams[k] as string) : "")
  const deviceName = cleanDeviceName(one("device_name"))
  const challenge = one("code_challenge")
  const redirect = one("redirect_uri")
  const state = one("state")
  const valid = !!deviceName && isValidChallenge(challenge) && isValidLoopbackRedirect(redirect)
  return (
    <div className="mx-auto max-w-lg p-6">
      <h1 className="text-xl font-semibold">Approve the TD Storage app</h1>
      {valid ? (
        <ApproveDevice deviceName={deviceName!} codeChallenge={challenge} redirectUri={redirect} state={state} code={checkCode(challenge)} />
      ) : (
        <p className="mt-3 text-sm text-muted-foreground">This link is not complete. Open the TD Storage app on your Mac and sign in from there.</p>
      )}
    </div>
  )
}
