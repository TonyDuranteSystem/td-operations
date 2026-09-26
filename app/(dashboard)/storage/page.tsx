import { StorageBrowserClient } from "./storage-browser-client"
import { StorageTabs } from "./storage-tabs"
import { isProductionDatabase } from "@/lib/google-drive-guard"

export const dynamic = "force-dynamic"

export default function StoragePage() {
  // The NEW CRM store exists only in the sandbox for now (job 685467b5): its read-only "New storage"
  // tab is shown only there; production keeps exactly today's page.
  const showNewStore = !isProductionDatabase()
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
