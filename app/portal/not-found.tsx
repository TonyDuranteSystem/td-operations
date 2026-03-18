import { FileQuestion } from 'lucide-react'
import Link from 'next/link'

export default function PortalNotFound() {
  return (
    <div className="min-h-[50vh] flex items-center justify-center p-6">
      <div className="text-center max-w-sm">
        <FileQuestion className="h-12 w-12 text-zinc-300 mx-auto mb-4" />
        <h2 className="text-lg font-semibold text-zinc-900 mb-2">Page not found</h2>
        <p className="text-sm text-zinc-500 mb-4">
          The page you are looking for does not exist.
        </p>
        <Link
          href="/portal"
          className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700"
        >
          Go to Dashboard
        </Link>
      </div>
    </div>
  )
}
