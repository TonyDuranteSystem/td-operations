import { StorageBrowserClient } from "./storage-browser-client"
import { StorageTabs } from "./storage-tabs"
import { isProductionDatabase } from "@/lib/google-drive-guard"
import { createClient } from "@/lib/supabase/server"
import { isStoreStaffUser } from "@/lib/crm-store/access"
import { studyCopyAllowed } from "@/lib/crm-store/drive-import"

export const dynamic = "force-dynamic"

export default async function StoragePage() {
  // The NEW CRM store (job 685467b5): shown in the sandbox; in production to ALL STAFF (Antonio 2026-10-10: "Luca must see
  // everything — the storage will be official") and only where the study copy is switched on. Seeing is for every staff
  // member; changing study copies and "Import from Google Drive" stay with the owners until the cutover. A person's private
  // "My files" is still hidden from everyone but its owner (the navigation route decides). Clients see nothing different.
  let showNewStore = !isProductionDatabase()
  if (!showNewStore && studyCopyAllowed()) {
    const { data: { user } } = await createClient().auth.getUser()
    showNewStore = isStoreStaffUser(user)
  }
  return (
    <div className="p-4 sm:p-6 max-w-7xl mx-auto">
      <div className="mb-4 sm:mb-6">
        <h1 className="text-2xl font-semibold text-gray-900">Storage</h1>
        <p className="text-sm text-gray-500 mt-1">
          Folders and files, organized however your team sets them up. Not connected to Google Drive.
        </p>
      </div>
      {showNewStore ? <StorageTabs /> : <StorageBrowserClient />}
    </div>
  )
}
