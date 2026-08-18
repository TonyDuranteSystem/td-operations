import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { isAdmin } from '@/lib/auth'
import { ResearchConsole } from '@/components/research/research-console'

export default async function ResearchPage() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isAdmin(user)) {
    redirect('/')
  }

  return <ResearchConsole />
}
