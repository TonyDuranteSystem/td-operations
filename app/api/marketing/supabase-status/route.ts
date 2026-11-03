/** GET — is Supabase having an incident that can hurt us? See lib/infra/status-route.ts and docs/systems/supabase-status.md. */
import { handleSupabaseStatusGet } from '@/lib/infra/status-route'

export const dynamic = 'force-dynamic'

export async function GET() {
  return handleSupabaseStatusGet()
}
