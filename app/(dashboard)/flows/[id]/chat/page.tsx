import { notFound } from 'next/navigation'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { requireOpenServicesAccess } from '@/lib/open-services/audience'
import { FlowChat } from '@/components/flows/flow-chat'

/**
 * The client chat of ONE job, on its own page (dev job 388bb74b) — opened from the Calendar row's "Message client" button as a floating window.
 * The same chat panel the job's workspace has (same route, same messages). EVERY message written here goes to the CLIENT's portal chat and
 * notifies them by email, so the page says so in plain words; internal remarks belong in the job's team notes.
 * Same door as the Calendar: only people who may see it (staff AND the Calendar's audience setting).
 */
export const dynamic = 'force-dynamic'

export default async function FlowChatWindowPage({ params }: { params: { id: string } }) {
  const access = await requireOpenServicesAccess()
  if (!access.ok) notFound()

  const { data: sd } = await supabaseAdmin
    .from('service_deliveries')
    .select('id, service_type, account_id, contact_id')
    .eq('id', params.id)
    .maybeSingle()
  if (!sd) notFound()

  let name = ''
  if (sd.account_id) {
    const { data: a } = await supabaseAdmin.from('accounts').select('company_name').eq('id', sd.account_id).maybeSingle()
    name = a?.company_name ?? ''
  } else if (sd.contact_id) {
    const { data: c } = await supabaseAdmin.from('contacts').select('full_name').eq('id', sd.contact_id).maybeSingle()
    name = c?.full_name ?? ''
  }

  return (
    <div className="mx-auto max-w-3xl p-4">
      <h1 className="text-lg font-semibold">{name || 'Client'} — {sd.service_type}</h1>
      <p className="mt-1 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900" role="note">
        Messages here go to the client in their portal chat and they get an email. For a remark only the team should see, add a note on the Calendar row instead.
      </p>
      <div className="mt-3">
        <FlowChat serviceDeliveryId={sd.id} label="Message the client" />
      </div>
    </div>
  )
}
