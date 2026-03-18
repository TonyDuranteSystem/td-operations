import { createClient } from '@/lib/supabase/server'
import { getClientContactId } from '@/lib/portal-auth'

export default async function PortalHomePage() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()

  const contactId = user ? getClientContactId(user) : null

  return (
    <div className="max-w-4xl mx-auto">
      <div className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-900">Welcome to your Portal</h1>
        <p className="text-zinc-500 mt-1">Your company dashboard is coming soon.</p>
      </div>

      <div className="bg-white rounded-2xl border shadow-sm p-8 text-center">
        <div className="inline-flex items-center justify-center w-16 h-16 rounded-xl bg-blue-50 text-blue-600 text-3xl font-bold mb-4">
          TD
        </div>
        <h2 className="text-lg font-semibold text-zinc-900 mb-2">Portal Setup Complete</h2>
        <p className="text-sm text-zinc-500 max-w-md mx-auto">
          Your portal account is active. The full dashboard with documents, invoices, and services
          will be available soon.
        </p>
        {user && (
          <p className="text-xs text-zinc-400 mt-4">
            Logged in as {user.email}
            {contactId && ` (Contact ID: ${contactId.slice(0, 8)}...)`}
          </p>
        )}
      </div>
    </div>
  )
}
