import { StorageBrowserClient } from "./storage-browser-client"

export const dynamic = "force-dynamic"

export default function StoragePage() {
  return (
    <div className="p-4 sm:p-6 max-w-7xl mx-auto">
      <div className="mb-4 sm:mb-6">
        <h1 className="text-2xl font-semibold text-gray-900">Storage</h1>
        <p className="text-sm text-gray-500 mt-1">
          Folders and files, organized however your team sets them up. Not connected to Google Drive.
        </p>
      </div>
      <StorageBrowserClient />
    </div>
  )
}
