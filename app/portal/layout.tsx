import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { isClient } from '@/lib/auth'
import { Providers } from '@/components/providers'

export default async function PortalLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()

  // Not logged in → portal login
  if (!user) {
    redirect('/portal/login')
  }

  // Not a client → redirect away (admins go to dashboard)
  if (!isClient(user)) {
    // Allow admins through for debugging
    // If you want to block admins: redirect('/')
  }

  return (
    <Providers>
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50">
        {/* Portal sidebar and layout will be built in Step 2 */}
        <main className="p-6 lg:p-8">
          {children}
        </main>
      </div>
    </Providers>
  )
}
