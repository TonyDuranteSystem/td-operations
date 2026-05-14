'use client'

import { useEffect, useState, Suspense } from 'react'
import { useParams, useSearchParams } from 'next/navigation'
import dynamic from 'next/dynamic'

/**
 * Generic portal form viewer. Detects the form type from the token+code
 * via /api/forms/lookup, then renders the appropriate form component
 * INSIDE the portal layout (logged in, sidebar visible).
 *
 * To support a new form type:
 *   1. Add ONE entry to lib/forms/registry.ts
 *   2. Add ONE dynamic() line to FORM_COMPONENTS below
 */

type FormComponentProps = { token: string; accessCode: string; embedded: true; adminMode?: boolean }

const FORM_COMPONENTS: Record<string, React.ComponentType<FormComponentProps>> = {
  contact_request: dynamic(() =>
    import('@/components/forms/contact-request-form').then(m => ({ default: m.ContactRequestForm as React.ComponentType<FormComponentProps> }))
  ),
  member_info: dynamic(() =>
    import('@/components/forms/member-info-form').then(m => ({ default: m.MemberInfoForm as React.ComponentType<FormComponentProps> }))
  ),
}

function PortalFormPageInner() {
  const params = useParams()
  const searchParams = useSearchParams()
  const token = String(params.token)
  const accessCode = String(params.access_code)
  const adminMode = searchParams.get('preview') === 'td'

  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [formType, setFormType] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    fetch(`/api/forms/lookup/${token}/${accessCode}`)
      .then(r => r.json().then(d => ({ ok: r.ok, d })))
      .then(({ ok, d }) => {
        if (cancelled) return
        if (!ok) {
          setError(d.error || 'Form not found')
        } else {
          setFormType(d.form_type)
        }
        setLoading(false)
      })
      .catch(err => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : 'Failed to load form')
        setLoading(false)
      })
    return () => { cancelled = true }
  }, [token, accessCode])

  if (loading) {
    return <div className="p-8 text-center text-gray-500">Loading…</div>
  }

  if (error || !formType) {
    return (
      <div className="p-8 max-w-md mx-auto bg-white rounded-lg border mt-8 text-center">
        <p className="text-red-600">{error ?? 'Form not found'}</p>
      </div>
    )
  }

  const FormComponent = formType ? FORM_COMPONENTS[formType] : undefined

  if (!FormComponent) {
    return (
      <div className="p-8 max-w-md mx-auto bg-white rounded-lg border mt-8 text-center">
        <p className="text-amber-700">This form type is not yet available in the portal viewer.</p>
      </div>
    )
  }

  return <FormComponent token={token} accessCode={accessCode} embedded adminMode={adminMode} />
}

export default function PortalFormPage() {
  return (
    <Suspense fallback={<div className="p-8 text-center text-gray-500">Loading…</div>}>
      <PortalFormPageInner />
    </Suspense>
  )
}
