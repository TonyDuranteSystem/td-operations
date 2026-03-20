'use client'

import { useState, useEffect } from 'react'
import { Send, Mail, CheckCircle, AlertCircle, Loader2, Eye, RefreshCw, Globe } from 'lucide-react'

interface PortalAccount {
  id: string
  company_name: string
  contact_name: string
  contact_email: string | null
  portal_created_date: string | null
  notified: boolean
}

export default function PortalLaunchPage() {
  const [accounts, setAccounts] = useState<PortalAccount[]>([])
  const [loading, setLoading] = useState(true)
  const [sending, setSending] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [language, setLanguage] = useState<'en' | 'it'>('it')
  const [previewHtml, setPreviewHtml] = useState<string | null>(null)
  const [results, setResults] = useState<{ summary: { sent: number; skipped: number; failed: number }; results: { account_id: string; company: string; email: string; status: string; error?: string }[] } | null>(null)

  const fetchAccounts = async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/portal/admin/notify-launch')
      if (res.ok) {
        const data = await res.json()
        setAccounts(data.accounts || [])
      }
    } catch (err) {
      console.error('Failed to fetch accounts:', err)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { fetchAccounts() }, [])

  const toggleSelect = (id: string) => {
    setSelected(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  const selectAll = () => {
    const notNotified = accounts.filter(a => !a.notified && a.contact_email)
    if (selected.size === notNotified.length) {
      setSelected(new Set())
    } else {
      setSelected(new Set(notNotified.map(a => a.id)))
    }
  }

  const handlePreview = async () => {
    try {
      const res = await fetch('/api/portal/admin/notify-launch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ preview: true, language }),
      })
      if (res.ok) {
        const data = await res.json()
        setPreviewHtml(data.preview_html)
      }
    } catch (err) {
      console.error('Preview failed:', err)
    }
  }

  const handleSend = async (force?: boolean) => {
    if (selected.size === 0) return
    if (!confirm(`Send portal launch email to ${selected.size} client(s) in ${language === 'it' ? 'Italian' : 'English'}?`)) return

    setSending(true)
    setResults(null)
    try {
      const res = await fetch('/api/portal/admin/notify-launch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          account_ids: Array.from(selected),
          language,
          force,
        }),
      })
      if (res.ok) {
        const data = await res.json()
        setResults(data)
        // Refresh the list
        await fetchAccounts()
        setSelected(new Set())
      }
    } catch (err) {
      console.error('Send failed:', err)
    } finally {
      setSending(false)
    }
  }

  const notNotifiedCount = accounts.filter(a => !a.notified && a.contact_email).length
  const notifiedCount = accounts.filter(a => a.notified).length

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-zinc-900">Portal Launch Notifications</h1>
          <p className="text-sm text-zinc-500 mt-1">
            Send launch announcement emails to portal clients
          </p>
        </div>
        <button
          onClick={fetchAccounts}
          className="p-2 rounded-lg text-zinc-400 hover:text-zinc-600 hover:bg-zinc-100 transition-colors"
          title="Refresh"
        >
          <RefreshCw className="h-5 w-5" />
        </button>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-4 mb-6">
        <div className="bg-white border rounded-xl p-4">
          <p className="text-xs text-zinc-500 mb-1">Total Portal Accounts</p>
          <p className="text-2xl font-bold text-zinc-900">{accounts.length}</p>
        </div>
        <div className="bg-white border rounded-xl p-4">
          <p className="text-xs text-zinc-500 mb-1">Already Notified</p>
          <p className="text-2xl font-bold text-green-600">{notifiedCount}</p>
        </div>
        <div className="bg-white border rounded-xl p-4">
          <p className="text-xs text-zinc-500 mb-1">Pending Notification</p>
          <p className="text-2xl font-bold text-amber-600">{notNotifiedCount}</p>
        </div>
      </div>

      {/* Controls */}
      <div className="flex items-center gap-3 mb-4 flex-wrap">
        {/* Language selector */}
        <div className="flex items-center gap-2 bg-white border rounded-lg px-3 py-2">
          <Globe className="h-4 w-4 text-zinc-400" />
          <select
            value={language}
            onChange={e => setLanguage(e.target.value as 'en' | 'it')}
            className="text-sm bg-transparent border-none focus:outline-none cursor-pointer"
          >
            <option value="it">Italiano</option>
            <option value="en">English</option>
          </select>
        </div>

        <button
          onClick={handlePreview}
          className="flex items-center gap-2 px-4 py-2 bg-white border rounded-lg text-sm hover:bg-zinc-50 transition-colors"
        >
          <Eye className="h-4 w-4" />
          Preview Email
        </button>

        <button
          onClick={selectAll}
          className="flex items-center gap-2 px-4 py-2 bg-white border rounded-lg text-sm hover:bg-zinc-50 transition-colors"
        >
          {selected.size === notNotifiedCount && notNotifiedCount > 0 ? 'Deselect All' : `Select All Pending (${notNotifiedCount})`}
        </button>

        <button
          onClick={() => handleSend(false)}
          disabled={selected.size === 0 || sending}
          className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors ml-auto"
        >
          {sending ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Send className="h-4 w-4" />
          )}
          Send to Selected ({selected.size})
        </button>
      </div>

      {/* Results banner */}
      {results && (
        <div className="mb-4 border rounded-xl p-4 bg-green-50 border-green-200">
          <div className="flex items-center gap-2 mb-2">
            <CheckCircle className="h-5 w-5 text-green-600" />
            <span className="font-semibold text-green-800">Sending Complete</span>
          </div>
          <p className="text-sm text-green-700">
            Sent: {results.summary.sent} | Skipped: {results.summary.skipped} | Failed: {results.summary.failed}
          </p>
          {results.results.filter(r => r.status === 'failed').length > 0 && (
            <div className="mt-2 space-y-1">
              {results.results.filter(r => r.status === 'failed').map(r => (
                <p key={r.account_id} className="text-xs text-red-600">
                  {r.company} ({r.email}): {r.error}
                </p>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Preview modal */}
      {previewHtml && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => setPreviewHtml(null)}>
          <div className="bg-white rounded-xl shadow-2xl max-w-[640px] w-full max-h-[80vh] overflow-y-auto m-4" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between px-4 py-3 border-b">
              <h3 className="font-semibold text-sm">Email Preview ({language === 'it' ? 'Italiano' : 'English'})</h3>
              <button onClick={() => setPreviewHtml(null)} className="text-zinc-400 hover:text-zinc-600">Close</button>
            </div>
            <div dangerouslySetInnerHTML={{ __html: previewHtml }} />
          </div>
        </div>
      )}

      {/* Account list */}
      {loading ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="h-6 w-6 animate-spin text-zinc-400" />
        </div>
      ) : accounts.length === 0 ? (
        <div className="text-center py-20 text-zinc-500">
          <Mail className="h-12 w-12 mx-auto mb-3 text-zinc-300" />
          <p>No portal accounts found.</p>
          <p className="text-xs mt-1">Create portal accounts first from the Accounts page.</p>
        </div>
      ) : (
        <div className="bg-white border rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-zinc-50">
                <th className="w-10 px-4 py-3"></th>
                <th className="text-left px-4 py-3 font-medium text-zinc-600">Company</th>
                <th className="text-left px-4 py-3 font-medium text-zinc-600">Contact</th>
                <th className="text-left px-4 py-3 font-medium text-zinc-600">Email</th>
                <th className="text-left px-4 py-3 font-medium text-zinc-600">Portal Since</th>
                <th className="text-center px-4 py-3 font-medium text-zinc-600">Status</th>
              </tr>
            </thead>
            <tbody>
              {accounts.map(acc => (
                <tr
                  key={acc.id}
                  className={`border-b last:border-0 hover:bg-zinc-50 transition-colors ${
                    selected.has(acc.id) ? 'bg-blue-50' : ''
                  }`}
                >
                  <td className="px-4 py-3">
                    <input
                      type="checkbox"
                      checked={selected.has(acc.id)}
                      onChange={() => toggleSelect(acc.id)}
                      disabled={!acc.contact_email}
                      className="rounded border-zinc-300 text-blue-600 focus:ring-blue-500 disabled:opacity-30"
                    />
                  </td>
                  <td className="px-4 py-3 font-medium text-zinc-900">{acc.company_name}</td>
                  <td className="px-4 py-3 text-zinc-600">{acc.contact_name}</td>
                  <td className="px-4 py-3 text-zinc-600">
                    {acc.contact_email || <span className="text-red-400 text-xs">No email</span>}
                  </td>
                  <td className="px-4 py-3 text-zinc-500">{acc.portal_created_date || '—'}</td>
                  <td className="px-4 py-3 text-center">
                    {acc.notified ? (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-green-50 text-green-700 text-xs font-medium">
                        <CheckCircle className="h-3 w-3" />
                        Notified
                      </span>
                    ) : acc.contact_email ? (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 text-xs font-medium">
                        <AlertCircle className="h-3 w-3" />
                        Pending
                      </span>
                    ) : (
                      <span className="text-xs text-zinc-400">N/A</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
