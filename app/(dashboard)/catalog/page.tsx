import { listEntries, listPendingReview, getCatalog } from "@/lib/catalog/framework"
import { CatalogClient } from "./catalog-client"

export const dynamic = "force-dynamic"

const CATALOG_ID = "services"

export default async function CatalogAdminPage() {
  const [definition, entries, pending] = await Promise.all([
    getCatalog(CATALOG_ID),
    listEntries(CATALOG_ID, { includeDeprecated: true }),
    listPendingReview({ catalogId: CATALOG_ID, status: "pending" }),
  ])

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-gray-900">Catalog</h1>
        <p className="text-sm text-gray-500 mt-1">
          {definition?.display_name ?? CATALOG_ID} —{" "}
          {definition?.description ?? "Catalog framework entries"}
        </p>
      </div>
      <CatalogClient
        catalogId={CATALOG_ID}
        entries={entries}
        pending={pending}
      />
    </div>
  )
}
