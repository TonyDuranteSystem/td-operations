'use client'

import { useEffect, useState, Suspense } from 'react'
import { useParams } from 'next/navigation'
import { ContactRequestForm } from '@/components/forms/contact-request-form'

/**
 * Generic portal form viewer. Detects the form type from the token+code
 * via /api/forms/lookup, then renders the appropriate form component
 * INSIDE the portal layout (logged in, sidebar visible).
 *
 * To support a new form type:
 *   1. Register it in FORM_TABLES in /api/forms/lookup
 *   2. Import its form component and add a case in renderForm() below
 */
function PortalFormPageInner() {
  const params = useParams()
  const token = String(params.token)
  const accessCode = String(params.access_code)

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

  switch (formType) {
    case 'contact_request':
      return <ContactRequestForm token={token} accessCode={accessCode} embedded />
    default:
      return (
        <div className="p-8 max-w-md mx-auto bg-white rounded-lg border mt-8 text-center">
          <p className="text-amber-700">This form type is not yet available in the portal viewer.</p>
        </div>
      )
  }
}

export default function PortalFormPage() {
  return (
    <Suspense fallback={<div className="p-8 text-center text-gray-500">Loading…</div>}>
      <PortalFormPageInner />
    </Suspense>
  )
}
