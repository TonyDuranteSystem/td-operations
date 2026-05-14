'use client'

import { Suspense } from 'react'
import { useParams, useSearchParams } from 'next/navigation'
import { ContactRequestForm } from '@/components/forms/contact-request-form'

function ContactRequestPageInner() {
  const params = useParams()
  const searchParams = useSearchParams()
  const token = String(params.token)
  const accessCode = String(params.access_code)
  const adminMode = searchParams.get('preview') === 'td'

  return <ContactRequestForm token={token} accessCode={accessCode} adminMode={adminMode} />
}

export default function ContactRequestPage() {
  return (
    <Suspense fallback={<div className="min-h-screen flex items-center justify-center bg-gray-50"><div className="text-gray-500">Loading…</div></div>}>
      <ContactRequestPageInner />
    </Suspense>
  )
}
