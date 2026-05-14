'use client'

import { useEffect, useState, useCallback, Suspense } from 'react'
import { useParams, useSearchParams } from 'next/navigation'
import { LOGO_URL } from '@/lib/supabase/public-client'

// ─── Types ───────────────────────────────────────────────────

interface ContactRequestForm {
  id: string
  account_id: string | null
  recipient_contact_id: string
  target_contact_id: string | null
  form_type: 'add_new' | 'update_existing'
  status: 'pending' | 'submitted' | 'cancelled'
  pre_populated_data: ContactFormData | null
}

interface ContactFormData {
  full_name?: string
  email?: string
  phone?: string
  address_line1?: string
  address_city?: string
  address_state?: string
  address_zip?: string
  address_country?: string
  role?: string
}

interface RoleOption {
  slug: string
  display_name: string
  display_name_translations: Record<string, string>
}

// ─── Page ────────────────────────────────────────────────────

function ContactRequestPageInner() {
  const params = useParams()
  const searchParams = useSearchParams()
  const token = String(params.token)
  const accessCode = String(params.access_code)
  const adminMode = searchParams.get('preview') === 'td'

  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [form, setForm] = useState<ContactRequestForm | null>(null)
  const [companyName, setCompanyName] = useState<string | null>(null)
  const [roles, setRoles] = useState<RoleOption[]>([])

  const [data, setData] = useState<ContactFormData>({})
  const [submitting, setSubmitting] = useState(false)
  const [submitted, setSubmitted] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch(`/api/contact-request/${token}/${accessCode}`)
      const d = await res.json()
      if (!res.ok) {
        setError(d.error || 'Failed to load form.')
        setLoading(false)
        return
      }
      setForm(d.form)
      setCompanyName(d.company_name ?? null)
      setRoles(d.roles ?? [])
      const pre = d.form?.pre_populated_data ?? {}
      setData({
        full_name: pre.full_name ?? '',
        email: pre.email ?? '',
        phone: pre.phone ?? '',
        address_line1: pre.address_line1 ?? '',
        address_city: pre.address_city ?? '',
        address_state: pre.address_state ?? '',
        address_zip: pre.address_zip ?? '',
        address_country: pre.address_country ?? '',
        role: '',
      })
      if (d.form?.status === 'submitted') {
        setSubmitted(true)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load form.')
    } finally {
      setLoading(false)
    }
  }, [token, accessCode])

  useEffect(() => { load() }, [load])

  const set = (k: keyof ContactFormData, v: string) => setData(d => ({ ...d, [k]: v }))

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (adminMode) {
      alert('Admin preview — submission disabled.')
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      const res = await fetch(`/api/contact-request/${token}/${accessCode}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) {
        throw new Error(d.error || 'Submission failed.')
      }
      setSubmitted(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Submission failed.')
    } finally {
      setSubmitting(false)
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="text-gray-500">Loading…</div>
      </div>
    )
  }

  if (error && !form) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 p-4">
        <div className="bg-white rounded-lg shadow p-6 max-w-md text-center">
          <p className="text-red-600">{error}</p>
        </div>
      </div>
    )
  }

  if (!form) return null

  if (submitted) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 p-4">
        <div className="bg-white rounded-lg shadow p-8 max-w-md text-center">
          {LOGO_URL && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={LOGO_URL} alt="Tony Durante" className="h-12 mx-auto mb-4" />
          )}
          <h1 className="text-xl font-semibold text-gray-900 mb-2">Thank you!</h1>
          <p className="text-gray-600">
            {form.form_type === 'add_new'
              ? 'The new contact has been added.'
              : 'Your information has been updated.'}
          </p>
        </div>
      </div>
    )
  }

  const isAddNew = form.form_type === 'add_new'
  const title = isAddNew ? 'Add a New Contact' : 'Confirm Your Information'
  const subtitle = isAddNew
    ? `Add a new contact person${companyName ? ` for ${companyName}` : ''}.`
    : 'Please review and update your contact information below.'

  const inputCls = 'w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-red-500'
  const labelCls = 'text-xs font-medium text-gray-700 mb-1 block'

  return (
    <div className="min-h-screen bg-gray-50 py-8 px-4">
      {adminMode && (
        <div className="max-w-2xl mx-auto mb-4 bg-amber-50 border border-amber-300 text-amber-900 text-sm rounded-md px-4 py-2">
          ADMIN PREVIEW — submission disabled
        </div>
      )}
      <div className="max-w-2xl mx-auto bg-white rounded-lg shadow">
        <div className="border-b px-6 py-5">
          {LOGO_URL && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={LOGO_URL} alt="Tony Durante" className="h-10 mb-3" />
          )}
          <h1 className="text-xl font-semibold text-gray-900">{title}</h1>
          <p className="text-sm text-gray-600 mt-1">{subtitle}</p>
        </div>

        <form onSubmit={onSubmit} className="p-6 space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="md:col-span-2">
              <label className={labelCls}>Full Name *</label>
              <input className={inputCls} value={data.full_name ?? ''} onChange={e => set('full_name', e.target.value)} required />
            </div>
            <div>
              <label className={labelCls}>Email *</label>
              <input className={inputCls} type="email" value={data.email ?? ''} onChange={e => set('email', e.target.value)} required />
            </div>
            <div>
              <label className={labelCls}>Phone</label>
              <input className={inputCls} value={data.phone ?? ''} onChange={e => set('phone', e.target.value)} />
            </div>
            <div className="md:col-span-2">
              <label className={labelCls}>Street Address</label>
              <input className={inputCls} value={data.address_line1 ?? ''} onChange={e => set('address_line1', e.target.value)} />
            </div>
            <div>
              <label className={labelCls}>City</label>
              <input className={inputCls} value={data.address_city ?? ''} onChange={e => set('address_city', e.target.value)} />
            </div>
            <div>
              <label className={labelCls}>State / Province</label>
              <input className={inputCls} value={data.address_state ?? ''} onChange={e => set('address_state', e.target.value)} />
            </div>
            <div>
              <label className={labelCls}>ZIP / Postal Code</label>
              <input className={inputCls} value={data.address_zip ?? ''} onChange={e => set('address_zip', e.target.value)} />
            </div>
            <div>
              <label className={labelCls}>Country</label>
              <input className={inputCls} value={data.address_country ?? ''} onChange={e => set('address_country', e.target.value)} />
            </div>

            {isAddNew && (
              <div className="md:col-span-2">
                <label className={labelCls}>Role *</label>
                <select className={inputCls} value={data.role ?? ''} onChange={e => set('role', e.target.value)} required>
                  <option value="">Select a role…</option>
                  {roles.map(r => (
                    <option key={r.slug} value={r.slug}>{r.display_name}</option>
                  ))}
                </select>
              </div>
            )}
          </div>

          {error && (
            <div className="bg-red-50 border border-red-200 text-red-800 text-sm rounded-md px-3 py-2">{error}</div>
          )}

          <div className="pt-2">
            <button
              type="submit"
              disabled={submitting || adminMode}
              className="w-full inline-flex justify-center items-center px-4 py-2 bg-red-600 text-white text-sm font-medium rounded-md hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {submitting ? 'Submitting…' : (isAddNew ? 'Add Contact' : 'Update My Info')}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

export default function ContactRequestPage() {
  return (
    <Suspense fallback={<div className="min-h-screen flex items-center justify-center bg-gray-50"><div className="text-gray-500">Loading…</div></div>}>
      <ContactRequestPageInner />
    </Suspense>
  )
}
