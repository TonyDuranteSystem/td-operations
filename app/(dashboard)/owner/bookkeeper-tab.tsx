'use client'

import { useState, useEffect } from 'react'
import { toast } from 'sonner'

interface ReviewItem {
  id: string
  section: string
  item_number: number | null
  description: string
  amount: number | null
  transaction_date: string | null
  counterparty: string | null
  bank_account: string | null
  status: string
  answer: string | null
  answer_category: string | null
  answered_at: string | null
}

interface Review {
  id: string
  tax_year: number
  bookkeeper: string | null
  source_file_name: string | null
  status: string
  total_items: number
  answered_items: number
}

const fmt = (n: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(Math.abs(n))

interface BookkeeperTabProps {
  year?: number
}

export function BookkeeperTab({ year }: BookkeeperTabProps) {
  const [reviews, setReviews] = useState<Review[]>([])
  const [selectedReview, setSelectedReview] = useState<string | null>(null)
  const [items, setItems] = useState<ReviewItem[]>([])
  const [loadingReviews, setLoadingReviews] = useState(true)
  const [loadingItems, setLoadingItems] = useState(false)
  const [answeringId, setAnsweringId] = useState<string | null>(null)
  const [answerDraft, setAnswerDraft] = useState('')
  const [exportText, setExportText] = useState<string | null>(null)
  const [filterSection, setFilterSection] = useState<string>('')
  const [filterStatus, setFilterStatus] = useState<string>('pending')

  /**
   * Reviews for the SELECTED year.
   *
   * Until 2026-08-30 this tab took the year prop and never used it, fetching every
   * review from every year — so the page's year selector sat there doing nothing
   * on this tab. Keyed on `year` so switching the selector re-fetches; the open
   * review and its items are cleared too, since a review from the previous year
   * must not stay on screen (and its items are fetched by review id, which would
   * otherwise keep showing the old year's questions under the new year).
   */
  useEffect(() => {
    setLoadingReviews(true)
    setSelectedReview(null)
    setItems([])
    const qs = year ? `?year=${year}` : ''
    fetch(`/api/owner/bookkeeper${qs}`)
      .then(r => r.json())
      .then(d => { setReviews(d.reviews ?? []); setLoadingReviews(false) })
      .catch(() => setLoadingReviews(false))
  }, [year])

  async function loadItems(reviewId: string) {
    setLoadingItems(true)
    setSelectedReview(reviewId)
    try {
      const res = await fetch(`/api/owner/bookkeeper?id=${reviewId}`)
      const data = await res.json()
      setItems(data.items ?? [])
    } catch { toast.error('Failed to load items') }
    finally { setLoadingItems(false) }
  }

  async function saveAnswer(item: ReviewItem) {
    try {
      const res = await fetch(`/api/owner/bookkeeper/${selectedReview}/items/${item.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ answer: answerDraft, status: 'answered' }),
      })
      if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || 'Save failed') }
      setItems(prev => prev.map(i => i.id === item.id ? { ...i, answer: answerDraft, status: 'answered', answered_at: new Date().toISOString() } : i))
      setAnsweringId(null)
      setAnswerDraft('')
      toast.success('Answer saved')
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Save failed') }
  }

  async function generateExport() {
    if (!selectedReview) return
    try {
      const res = await fetch(`/api/owner/bookkeeper/${selectedReview}/export`)
      const data = await res.json()
      setExportText(data.export_text)
    } catch { toast.error('Export failed') }
  }

  const filteredItems = items.filter(i => {
    if (filterSection && i.section !== filterSection) return false
    if (filterStatus && i.status !== filterStatus) return false
    return true
  })

  const sections = Array.from(new Set(items.map(i => i.section)))
  const currentReview = reviews.find(r => r.id === selectedReview)

  if (loadingReviews) {
    return <div className="py-8 text-center text-sm text-zinc-400">Loading...</div>
  }

  return (
    <div className="space-y-6">
      {/* Review list / selector */}
      <div className="rounded-lg border border-zinc-200 bg-white p-4">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-medium text-zinc-700">Bookkeeper Reviews</h3>
        </div>

        {reviews.length === 0 ? (
          <div className="rounded-lg border-2 border-dashed border-zinc-200 py-8 text-center">
            {/* Now that the list is year-scoped, "nothing here" must say WHICH year —
                otherwise an empty panel reads as broken rather than as "try another
                year", which is the whole reason the selector was inert before. */}
            <p className="text-sm text-zinc-500">
              {year ? `No review sessions for ${year}.` : 'No review sessions yet.'}
            </p>
            <p className="mt-1 text-xs text-zinc-400">
              {year
                ? 'Use the year selector above to check another year.'
                : 'Import the bookkeeper review questions via the API to get started.'}
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {reviews.map(r => (
              <div
                key={r.id}
                onClick={() => loadItems(r.id)}
                className={`flex cursor-pointer items-center justify-between rounded-lg border p-3 transition-colors ${selectedReview === r.id ? 'border-zinc-900 bg-zinc-50' : 'border-zinc-200 hover:bg-zinc-50'}`}
              >
                <div>
                  <div className="text-sm font-medium text-zinc-800">{r.tax_year} Review</div>
                  {r.bookkeeper && <div className="text-xs text-zinc-400">Bookkeeper: {r.bookkeeper}</div>}
                  {r.source_file_name && <div className="text-xs text-zinc-400">Source: {r.source_file_name}</div>}
                </div>
                <div className="text-right">
                  <div className="text-sm font-medium text-zinc-700">{r.answered_items} / {r.total_items} answered</div>
                  <div className="mt-1 h-1.5 w-32 rounded-full bg-zinc-100">
                    <div
                      className="h-1.5 rounded-full bg-green-500"
                      style={{ width: r.total_items > 0 ? `${(r.answered_items / r.total_items) * 100}%` : '0%' }}
                    />
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Review items */}
      {selectedReview && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-medium text-zinc-700">
              {currentReview?.tax_year} Review Items
            </h3>
            <div className="flex items-center gap-2">
              <select
                value={filterSection}
                onChange={e => setFilterSection(e.target.value)}
                className="rounded-md border border-zinc-200 px-2 py-1 text-xs"
              >
                <option value="">All sections</option>
                {sections.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
              <select
                value={filterStatus}
                onChange={e => setFilterStatus(e.target.value)}
                className="rounded-md border border-zinc-200 px-2 py-1 text-xs"
              >
                <option value="">All statuses</option>
                <option value="pending">Pending</option>
                <option value="answered">Answered</option>
                <option value="skipped">Skipped</option>
              </select>
              <button
                onClick={generateExport}
                className="rounded-md border border-zinc-200 px-3 py-1 text-xs hover:bg-zinc-50"
              >
                Generate Response
              </button>
            </div>
          </div>

          {loadingItems ? (
            <div className="py-4 text-center text-sm text-zinc-400">Loading items...</div>
          ) : (
            <div className="space-y-2">
              {filteredItems.map(item => (
                <div
                  key={item.id}
                  className={`rounded-lg border p-4 ${item.status === 'answered' ? 'border-green-200 bg-green-50/50' : 'border-zinc-200 bg-white'}`}
                >
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex-1">
                      <div className="mb-1 flex items-center gap-2">
                        <span className="rounded bg-zinc-100 px-2 py-0.5 text-xs text-zinc-500">{item.section}</span>
                        {item.item_number && <span className="text-xs text-zinc-400">#{item.item_number}</span>}
                        {item.amount && (
                          <span className="text-xs font-medium text-zinc-600">{fmt(item.amount)}</span>
                        )}
                        {item.bank_account && <span className="text-xs text-zinc-400">{item.bank_account}</span>}
                        <span className={`ml-auto rounded-full px-2 py-0.5 text-xs font-medium ${item.status === 'answered' ? 'bg-green-100 text-green-700' : item.status === 'skipped' ? 'bg-zinc-100 text-zinc-500' : 'bg-orange-100 text-orange-700'}`}>
                          {item.status}
                        </span>
                      </div>
                      <p className="text-sm text-zinc-800">{item.description}</p>

                      {item.answer && (
                        <div className="mt-2 rounded bg-green-100 px-3 py-1.5 text-sm text-green-800">
                          {item.answer}
                        </div>
                      )}

                      {answeringId === item.id ? (
                        <div className="mt-3 space-y-2">
                          <textarea
                            value={answerDraft}
                            onChange={e => setAnswerDraft(e.target.value)}
                            placeholder="Type your answer..."
                            rows={3}
                            className="w-full rounded-md border border-zinc-200 px-3 py-2 text-sm"
                            autoFocus
                          />
                          <div className="flex gap-2">
                            <button
                              onClick={() => saveAnswer(item)}
                              className="rounded bg-zinc-900 px-3 py-1.5 text-sm text-white hover:bg-zinc-700"
                            >
                              Save Answer
                            </button>
                            <button
                              onClick={() => { setAnsweringId(null); setAnswerDraft('') }}
                              className="rounded border border-zinc-200 px-3 py-1.5 text-sm hover:bg-zinc-100"
                            >
                              Cancel
                            </button>
                          </div>
                        </div>
                      ) : (
                        item.status !== 'answered' && (
                          <button
                            onClick={() => { setAnsweringId(item.id); setAnswerDraft(item.answer ?? '') }}
                            className="mt-2 text-xs text-zinc-500 underline hover:text-zinc-700"
                          >
                            {item.answer ? 'Edit answer' : 'Answer this item'}
                          </button>
                        )
                      )}
                    </div>
                  </div>
                </div>
              ))}

              {filteredItems.length === 0 && (
                <div className="py-4 text-center text-sm text-zinc-400">No items match the current filter.</div>
              )}
            </div>
          )}

          {/* Export modal */}
          {exportText && (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
              <div className="w-full max-w-2xl rounded-xl bg-white p-6 shadow-2xl">
                <div className="mb-4 flex items-center justify-between">
                  <h3 className="font-semibold text-zinc-900">Bookkeeper Response</h3>
                  <button onClick={() => setExportText(null)} className="text-zinc-400 hover:text-zinc-600">✕</button>
                </div>
                <textarea
                  value={exportText}
                  onChange={e => setExportText(e.target.value)}
                  rows={18}
                  className="w-full rounded-md border border-zinc-200 px-3 py-2 font-mono text-sm"
                />
                <div className="mt-4 flex justify-end gap-2">
                  <button
                    onClick={() => { navigator.clipboard.writeText(exportText); toast.success('Copied') }}
                    className="rounded-md bg-zinc-900 px-4 py-2 text-sm text-white hover:bg-zinc-700"
                  >
                    Copy to clipboard
                  </button>
                  <button onClick={() => setExportText(null)} className="rounded-md border border-zinc-200 px-4 py-2 text-sm">Close</button>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
