'use client'

import { Suspense } from 'react'
import { useParams, useSearchParams } from 'next/navigation'
import { MemberInfoForm } from '@/components/forms/member-info-form'

function MemberInfoPageInner() {
  const params = useParams()
  const searchParams = useSearchParams()
  return (
    <MemberInfoForm
      token={String(params.token)}
      accessCode={String(params.access_code)}
      adminMode={searchParams.get('preview') === 'td'}
    />
  )
}

export default function MemberInfoPage() {
  return (
    <Suspense fallback={<div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', color: '#6b7280' }}>Loading...</div>}>
      <MemberInfoPageInner />
    </Suspense>
  )
}
