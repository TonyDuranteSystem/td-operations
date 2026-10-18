/**
 * /storage-app/devices — "My devices": the Macs signed in to TD Storage (dev job 1992a087, P1). Every staff member sees and can sign out
 * their own; an OWNER also sees everyone's (to sign out a leaver's Mac) and has "Sign out all Macs".
 */
import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { isOwnerOnly } from "@/lib/auth"
import { isStoreStaffUser } from "@/lib/crm-store/access"
import { listAllDevices, listDevices } from "@/lib/storage-app/device-auth"
import { DevicesList } from "./devices-list"

export const dynamic = "force-dynamic"

export default async function StorageAppDevicesPage() {
  const { data: { user } } = await createClient().auth.getUser()
  if (!user || !isStoreStaffUser(user)) redirect("/")
  const owner = isOwnerOnly(user)
  const rows = owner
    ? await listAllDevices()
    : (await listDevices(user.id)).map((d) => ({ ...d, user_id: user.id, email: user.email ?? null }))
  return (
    <div className="mx-auto max-w-3xl p-6">
      <h1 className="text-xl font-semibold">TD Storage — Macs signed in</h1>
      <p className="mt-1 text-sm text-muted-foreground">Signing a Mac out stops it at once; it clears its TD Storage folder the next time the app runs there.</p>
      <DevicesList rows={rows} owner={owner} selfId={user.id} />
    </div>
  )
}
