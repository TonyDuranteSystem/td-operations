import { redirect } from 'next/navigation'

/** The old one-lead page: the lead now opens beside the list. Old links keep working. */
export default async function MarketingLeadRedirect({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  redirect(`/marketing/leads?lead=${encodeURIComponent(id)}`)
}
