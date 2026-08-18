'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { toast } from 'sonner'
import { Plus, X, Search, Save, Loader2, ChevronRight, Download, LayoutGrid, List, Rows3 } from 'lucide-react'
import { ENTITY_REGISTRY, unionFieldsAcrossEntities, type FieldConfig } from '@/lib/research/entity-registry'
import { OPERATORS_BY_TYPE, type Operator, type Condition } from '@/lib/research/query-builder'
import { emptyDraft, draftToCondition, type DraftCondition } from '@/lib/research/draft-condition'

const OPERATOR_LABELS: Record<Operator, string> = {
  contains: 'contains',
  equals: 'is',
  starts_with: 'starts with',
  is_any_of: 'is any of',
  before: 'is before',
  after: 'is after',
  on_or_after: 'is on/after',
  on_or_before: 'is on/before',
  between: 'is between',
  gt: 'is greater than',
  gte: 'is at least',
  lt: 'is less than',
  lte: 'is at most',
  is_true: 'is yes',
  is_false: 'is no',
  is_empty: 'is empty',
  is_not_empty: 'is not empty',
}

function conditionSummary(field: FieldConfig, c: DraftCondition | Condition): string {
  const op = OPERATOR_LABELS[c.operator as Operator]
  if (c.operator === 'is_empty' || c.operator === 'is_true' || c.operator === 'is_false' || c.operator === 'is_not_empty') {
    return `${field.label} ${op}`
  }
  if (c.operator === 'is_any_of') {
    const vals = 'values' in c ? c.values : []
    return `${field.label} ${op}: ${vals && vals.length ? vals.join(', ') : '—'}`
  }
  if (c.operator === 'between') {
    return `${field.label} ${op} ${'value' in c ? c.value : ''} and ${'value2' in c ? c.value2 : ''}`
  }
  return `${field.label} ${op} ${'value' in c ? c.value : ''}`
}

interface EntitySearchResult {
  entity: string
  items: Record<string, unknown>[]
  total: number
  truncated: boolean
}

interface SavedSearch {
  id: string
  name: string
  entities: string[]
  conditions: Condition[]
  created_by: string | null
  created_at: string
}

type ViewMode = 'table' | 'cards' | 'grouped'

export function ResearchConsole() {
  const allEntityKeys = useMemo(() => Object.keys(ENTITY_REGISTRY), [])
  const [selectedEntities, setSelectedEntities] = useState<string[]>([allEntityKeys[0]])
  const unionFields = useMemo(() => unionFieldsAcrossEntities(selectedEntities), [selectedEntities])

  const [conditions, setConditions] = useState<Condition[]>([])
  const [addingField, setAddingField] = useState<string | null>(null)
  const [draft, setDraft] = useState<DraftCondition | null>(null)
  const [fieldOptions, setFieldOptions] = useState<{ value: string; label: string }[]>([])
  const [optionsLoading, setOptionsLoading] = useState(false)
  const [fieldSearch, setFieldSearch] = useState('')

  const [viewMode, setViewMode] = useState<ViewMode>('table')
  const [results, setResults] = useState<EntitySearchResult[]>([])
  const [loading, setLoading] = useState(false)
  const [page, setPage] = useState(1)
  const [exporting, setExporting] = useState(false)

  const [savedSearches, setSavedSearches] = useState<SavedSearch[]>([])
  const [saveName, setSaveName] = useState('')
  const [savingOpen, setSavingOpen] = useState(false)

  const totalCount = results.reduce((sum, r) => sum + r.total, 0)
  const anyTruncated = results.some(r => r.truncated)

  const runSearch = useCallback(async (targetPage = 1) => {
    setLoading(true)
    try {
      const res = await fetch('/api/research/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entities: selectedEntities, conditions, page: targetPage }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error || 'Search failed — please try again.')
      }
      const data = await res.json()
      setResults(data.results)
      setPage(targetPage)
    } catch (e) {
      toast.error(e instanceof Error && e.message ? e.message : 'Search failed.')
    } finally {
      setLoading(false)
    }
  }, [selectedEntities, conditions])

  useEffect(() => {
    if (selectedEntities.length === 0) { setResults([]); return }
    runSearch(1)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedEntities, conditions])

  useEffect(() => {
    fetch('/api/research/saved-searches')
      .then(r => r.json())
      .then(d => setSavedSearches(d.items ?? []))
      .catch(() => {})
  }, [])

  // Dropping conditions that no longer belong to any selected entity keeps
  // the chip row honest — a filter chip that silently applies to nothing is
  // worse than removing it and telling the user why.
  function toggleEntity(key: string) {
    setSelectedEntities(prev => {
      const next = prev.includes(key) ? prev.filter(k => k !== key) : [...prev, key]
      return next
    })
    setConditions(prev => {
      const stillValid = prev.filter(c => {
        const nextEntities = selectedEntities.includes(key) ? selectedEntities.filter(k => k !== key) : [...selectedEntities, key]
        return nextEntities.some(k => ENTITY_REGISTRY[k]?.fields.some(f => f.key === c.field))
      })
      if (stillValid.length !== prev.length) toast.message('Removed a filter that no longer applies to any selected record type.')
      return stillValid
    })
  }

  function startAddingField(fieldKey: string) {
    const uf = unionFields.find(u => u.field.key === fieldKey)
    if (!uf) return
    setAddingField(fieldKey)
    setDraft(emptyDraft(fieldKey, uf.field.type))
    setFieldSearch('')
    if (uf.field.type === 'select' || uf.field.type === 'reference') {
      loadOptions(uf.field, '')
    }
  }

  async function loadOptions(field: FieldConfig, q: string) {
    setOptionsLoading(true)
    try {
      const params = new URLSearchParams({ entities: selectedEntities.join(','), field: field.key, q })
      const res = await fetch(`/api/research/field-values?${params}`)
      const data = await res.json()
      setFieldOptions(data.options ?? [])
    } catch {
      setFieldOptions([])
    } finally {
      setOptionsLoading(false)
    }
  }

  function confirmDraft() {
    if (!draft) return
    const uf = unionFields.find(u => u.field.key === draft.field)
    if (!uf) return
    const cond = draftToCondition(uf.field, draft)
    if (!cond) {
      toast.error('Enter a value before adding this filter.')
      return
    }
    setConditions(prev => [...prev, cond])
    setAddingField(null)
    setDraft(null)
  }

  function autoApply(specificDraft: DraftCondition) {
    const uf = unionFields.find(u => u.field.key === specificDraft.field)
    if (!uf) return
    const cond = draftToCondition(uf.field, specificDraft)
    if (!cond) return
    setConditions(prev => [...prev, cond])
    setAddingField(null)
    setDraft(null)
  }

  function removeCondition(idx: number) {
    setConditions(prev => prev.filter((_, i) => i !== idx))
  }

  async function saveSearch() {
    if (!saveName.trim()) return
    const res = await fetch('/api/research/saved-searches', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: saveName.trim(), entities: selectedEntities, conditions }),
    })
    if (!res.ok) {
      const d = await res.json().catch(() => ({}))
      toast.error(d.error || 'Could not save this search.')
      return
    }
    const data = await res.json()
    setSavedSearches(prev => [data.item, ...prev])
    setSaveName('')
    setSavingOpen(false)
    toast.success('Search saved.')
  }

  function openSaved(s: SavedSearch) {
    setSelectedEntities(s.entities)
    setConditions(s.conditions)
  }

  async function deleteSaved(id: string) {
    setSavedSearches(prev => prev.filter(s => s.id !== id))
    await fetch(`/api/research/saved-searches/${id}`, { method: 'DELETE' })
  }

  async function exportExcel() {
    setExporting(true)
    try {
      const res = await fetch('/api/research/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entities: selectedEntities, conditions }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error || 'Export failed — please try again.')
      }
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `research-${new Date().toISOString().slice(0, 10)}.xlsx`
      a.click()
      URL.revokeObjectURL(url)
    } catch (e) {
      toast.error(e instanceof Error && e.message ? e.message : 'Export failed.')
    } finally {
      setExporting(false)
    }
  }

  const availableFields = unionFields.filter(u =>
    !fieldSearch.trim() || u.field.label.toLowerCase().includes(fieldSearch.trim().toLowerCase())
  )

  return (
    <div className="max-w-screen-xl mx-auto px-4 py-6 space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-xl font-semibold text-zinc-900">Research</h1>
          <p className="text-sm text-zinc-500 mt-0.5">Build a filter, search across the CRM.</p>
        </div>
      </div>

      {/* Record type multi-select */}
      <div className="flex flex-wrap gap-1.5">
        {allEntityKeys.map(k => {
          const active = selectedEntities.includes(k)
          return (
            <button
              key={k}
              onClick={() => toggleEntity(k)}
              className={`px-2.5 py-1 rounded-full text-xs font-medium ring-1 transition-colors ${active ? 'bg-zinc-900 text-white ring-zinc-900' : 'bg-white text-zinc-600 ring-zinc-200 hover:ring-zinc-400'}`}
            >
              {ENTITY_REGISTRY[k].label}
            </button>
          )
        })}
      </div>

      {savedSearches.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-zinc-400">Saved:</span>
          {savedSearches.map(s => (
            <span key={s.id} className="inline-flex items-center gap-1 rounded-full bg-zinc-100 px-2.5 py-1">
              <button onClick={() => openSaved(s)} className="text-zinc-700 hover:text-zinc-900">
                {s.name} <span className="text-zinc-400">({s.entities.map(e => ENTITY_REGISTRY[e]?.label ?? e).join(', ')})</span>
              </button>
              <button onClick={() => deleteSaved(s.id)} className="text-zinc-400 hover:text-red-600">
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      )}

      {/* Filter chips */}
      <div className="flex flex-wrap items-center gap-2">
        {conditions.map((c, idx) => {
          const uf = unionFields.find(u => u.field.key === c.field)
          if (!uf) return null
          return (
            <span key={idx} className="inline-flex items-center gap-1.5 rounded-full bg-blue-50 text-blue-800 ring-1 ring-blue-200 px-2.5 py-1 text-xs font-medium">
              {conditionSummary(uf.field, c)}
              {uf.appliesTo.length < selectedEntities.length && (
                <span className="text-blue-400 font-normal">· {uf.appliesTo.map(e => ENTITY_REGISTRY[e]?.label ?? e).join(', ')} only</span>
              )}
              <button onClick={() => removeCondition(idx)} className="text-blue-400 hover:text-blue-700">
                <X className="h-3 w-3" />
              </button>
            </span>
          )
        })}

        {addingField === null && selectedEntities.length > 0 ? (
          <button
            onClick={() => setAddingField('')}
            className="inline-flex items-center gap-1 rounded-full border border-dashed border-zinc-300 px-2.5 py-1 text-xs font-medium text-zinc-500 hover:border-zinc-400 hover:text-zinc-700"
          >
            <Plus className="h-3 w-3" /> Add filter
          </button>
        ) : null}
      </div>

      {/* Field picker step */}
      {addingField === '' && (
        <div className="rounded-lg border border-zinc-200 bg-white p-3 space-y-2 max-w-sm">
          <input
            autoFocus
            value={fieldSearch}
            onChange={e => setFieldSearch(e.target.value)}
            placeholder="Search fields…"
            className="w-full rounded-md border border-zinc-200 px-2.5 py-1.5 text-sm"
          />
          <div className="max-h-56 overflow-y-auto divide-y divide-zinc-100">
            {availableFields.map(uf => (
              <button
                key={uf.field.key}
                onClick={() => startAddingField(uf.field.key)}
                className="flex w-full items-center justify-between py-1.5 text-sm text-zinc-700 hover:text-zinc-900"
              >
                <span>
                  {uf.field.label}
                  {uf.appliesTo.length < selectedEntities.length && (
                    <span className="text-zinc-400 text-xs ml-1.5">({uf.appliesTo.map(e => ENTITY_REGISTRY[e]?.label ?? e).join(', ')})</span>
                  )}
                </span>
                <ChevronRight className="h-3.5 w-3.5 text-zinc-300" />
              </button>
            ))}
            {availableFields.length === 0 && (
              <div className="py-3 text-sm text-zinc-400">No fields match &quot;{fieldSearch}&quot;.</div>
            )}
          </div>
          <button onClick={() => setAddingField(null)} className="text-xs text-zinc-400 hover:text-zinc-600">Cancel</button>
        </div>
      )}

      {/* Operator + value step */}
      {addingField && draft && (
        <ConditionEditor
          field={unionFields.find(u => u.field.key === addingField)!.field}
          draft={draft}
          setDraft={setDraft}
          onAutoApply={autoApply}
          options={fieldOptions}
          optionsLoading={optionsLoading}
          onSearchOptions={q => loadOptions(unionFields.find(u => u.field.key === addingField)!.field, q)}
          onConfirm={confirmDraft}
          onCancel={() => { setAddingField(null); setDraft(null) }}
        />
      )}

      {/* Results header: count, view switcher, export, save */}
      <div className="flex items-center justify-between flex-wrap gap-2 pt-2">
        <p className="text-sm text-zinc-500">
          {loading ? 'Searching…' : selectedEntities.length === 0 ? 'Pick at least one record type.' : `${totalCount} matching record${totalCount === 1 ? '' : 's'}`}
        </p>
        <div className="flex items-center gap-2">
          {selectedEntities.length > 1 && (
            <div className="inline-flex rounded-md ring-1 ring-zinc-200 overflow-hidden">
              <button onClick={() => setViewMode('table')} title="Table" className={`p-1.5 ${viewMode === 'table' ? 'bg-zinc-900 text-white' : 'bg-white text-zinc-500 hover:bg-zinc-50'}`}><List className="h-3.5 w-3.5" /></button>
              <button onClick={() => setViewMode('cards')} title="Cards" className={`p-1.5 ${viewMode === 'cards' ? 'bg-zinc-900 text-white' : 'bg-white text-zinc-500 hover:bg-zinc-50'}`}><LayoutGrid className="h-3.5 w-3.5" /></button>
              <button onClick={() => setViewMode('grouped')} title="Grouped by type" className={`p-1.5 ${viewMode === 'grouped' ? 'bg-zinc-900 text-white' : 'bg-white text-zinc-500 hover:bg-zinc-50'}`}><Rows3 className="h-3.5 w-3.5" /></button>
            </div>
          )}
          {selectedEntities.length > 0 && (
            <button onClick={exportExcel} disabled={exporting} className="inline-flex items-center gap-1 text-xs font-medium text-zinc-500 hover:text-zinc-800 disabled:opacity-50">
              {exporting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />} Export to Excel
            </button>
          )}
          {conditions.length > 0 && (
            savingOpen ? (
              <div className="flex items-center gap-1.5">
                <input
                  autoFocus
                  value={saveName}
                  onChange={e => setSaveName(e.target.value)}
                  placeholder="Name this search"
                  className="rounded-md border border-zinc-200 px-2 py-1 text-sm"
                  onKeyDown={e => e.key === 'Enter' && saveSearch()}
                />
                <button onClick={saveSearch} className="text-xs font-medium text-blue-600 hover:text-blue-800">Save</button>
                <button onClick={() => setSavingOpen(false)} className="text-xs text-zinc-400">Cancel</button>
              </div>
            ) : (
              <button onClick={() => setSavingOpen(true)} className="inline-flex items-center gap-1 text-xs font-medium text-zinc-500 hover:text-zinc-800">
                <Save className="h-3.5 w-3.5" /> Save this search
              </button>
            )
          )}
        </div>
      </div>

      {anyTruncated && (
        <p className="text-xs text-amber-700 bg-amber-50 ring-1 ring-amber-200 rounded-md px-2.5 py-1.5">
          Showing the first page of results for one or more record types — narrow your filters to see everything, or use Export to Excel for the full set.
        </p>
      )}

      <ResultsView
        results={results}
        loading={loading}
        viewMode={selectedEntities.length > 1 ? viewMode : 'table'}
      />

      {selectedEntities.length === 1 && results[0] && results[0].total > results[0].items.length && (
        <div className="flex items-center justify-center gap-3 text-sm text-zinc-500">
          <button disabled={page <= 1} onClick={() => runSearch(page - 1)} className="disabled:opacity-30">Previous</button>
          <span>Page {page}</span>
          <button onClick={() => runSearch(page + 1)}>Next</button>
        </div>
      )}
    </div>
  )
}

function ResultsView({ results, loading, viewMode }: { results: EntitySearchResult[]; loading: boolean; viewMode: ViewMode }) {
  if (loading && results.every(r => r.items.length === 0)) {
    return (
      <div className="rounded-lg border border-zinc-200 bg-white flex items-center justify-center py-14 text-zinc-400">
        <Loader2 className="h-5 w-5 animate-spin" />
      </div>
    )
  }

  const total = results.reduce((sum, r) => sum + r.total, 0)
  if (total === 0) {
    return (
      <div className="rounded-lg border border-zinc-200 bg-white py-14 text-center text-sm text-zinc-400">
        No matching records.
      </div>
    )
  }

  if (viewMode === 'grouped') {
    return (
      <div className="space-y-6">
        {results.filter(r => r.items.length > 0).map(r => (
          <div key={r.entity}>
            <div className="text-xs font-semibold uppercase tracking-wide text-zinc-400 mb-1.5">
              {ENTITY_REGISTRY[r.entity]?.label ?? r.entity} · {r.total}
            </div>
            <EntityTable entity={r.entity} items={r.items} />
          </div>
        ))}
      </div>
    )
  }

  if (viewMode === 'cards') {
    return (
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {results.flatMap(r => r.items.map((item, i) => (
          <RecordCard key={`${r.entity}-${i}`} entity={r.entity} item={item} showType={results.length > 1} />
        )))}
      </div>
    )
  }

  // Table mode.
  if (results.length === 1) {
    return <EntityTable entity={results[0].entity} items={results[0].items} />
  }

  // Multiple entities, flat mixed table: only generic columns fit since
  // different types have different fields — Type, Name, and one detail line.
  return (
    <div className="rounded-lg border border-zinc-200 bg-white overflow-x-auto">
      <table className="w-full min-w-[520px] text-sm">
        <thead>
          <tr className="border-b border-zinc-200 bg-zinc-50">
            <th className="px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-zinc-400">Type</th>
            <th className="px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-zinc-400">Name</th>
            <th className="px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-zinc-400 hidden md:table-cell">Detail</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-100">
          {results.flatMap(r => {
            const entity = ENTITY_REGISTRY[r.entity]
            return r.items.map((item, i) => {
              const detailField = entity?.fields.find(f => f.key !== entity.displayField && f.type === 'select')
              const detail = detailField ? item[detailField.key] : undefined
              const name = String(item[entity?.displayField ?? 'id'] ?? '—')
              return (
                <tr key={`${r.entity}-${i}`} className="hover:bg-zinc-50">
                  <td className="px-4 py-3 text-zinc-500">{entity?.label ?? r.entity}</td>
                  <td className="px-4 py-3 font-medium text-zinc-900">
                    {entity?.linkPrefix && item.id ? (
                      <Link href={`${entity.linkPrefix}/${item.id}`} className="hover:text-blue-700">{name}</Link>
                    ) : name}
                  </td>
                  <td className="px-4 py-3 text-zinc-600 hidden md:table-cell">{detail ? String(detail) : '—'}</td>
                </tr>
              )
            })
          })}
        </tbody>
      </table>
    </div>
  )
}

function EntityTable({ entity: entityKey, items }: { entity: string; items: Record<string, unknown>[] }) {
  const entity = ENTITY_REGISTRY[entityKey]
  const displayColumns = useMemo(() => {
    if (!entity) return []
    const cols = [entity.displayField]
    for (const f of entity.fields) {
      if (cols.length >= 5) break
      if (f.key !== entity.displayField && f.type !== 'reference') cols.push(f.key)
    }
    return cols
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entityKey])

  if (!entity) return null

  return (
    <div className="rounded-lg border border-zinc-200 bg-white overflow-x-auto">
      <table className="w-full min-w-[640px] text-sm">
        <thead>
          <tr className="border-b border-zinc-200 bg-zinc-50">
            {displayColumns.map((col, i) => (
              <th key={col} className={`px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-zinc-400 ${i > 0 ? 'hidden md:table-cell' : ''}`}>
                {entity.fields.find(f => f.key === col)?.label ?? col}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-100">
          {items.map((row, ri) => (
            <tr key={ri} className="hover:bg-zinc-50">
              {displayColumns.map((col, ci) => {
                const val = row[col]
                const content = val === null || val === undefined || val === '' ? '—' : String(val)
                const isFirst = ci === 0
                const inner = isFirst && entity.linkPrefix && row.id ? (
                  <Link href={`${entity.linkPrefix}/${row.id}`} className="font-medium text-zinc-900 hover:text-blue-700">{content}</Link>
                ) : (
                  <span className={isFirst ? 'font-medium text-zinc-900' : 'text-zinc-600'}>{content}</span>
                )
                return <td key={col} className={`px-4 py-3 ${ci > 0 ? 'hidden md:table-cell' : ''}`}>{inner}</td>
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function RecordCard({ entity: entityKey, item, showType }: { entity: string; item: Record<string, unknown>; showType: boolean }) {
  const entity = ENTITY_REGISTRY[entityKey]
  if (!entity) return null
  const name = String(item[entity.displayField] ?? '—')
  const detailFields = entity.fields.filter(f => f.key !== entity.displayField && f.type !== 'reference').slice(0, 3)

  const body = (
    <div className="rounded-lg border border-zinc-200 bg-white p-3 space-y-1.5 hover:border-zinc-300 transition-colors">
      {showType && <div className="text-xs font-medium text-zinc-400 uppercase tracking-wide">{entity.label}</div>}
      <div className="font-medium text-zinc-900 text-sm">{name}</div>
      {detailFields.map(f => {
        const v = item[f.key]
        if (v === null || v === undefined || v === '') return null
        return (
          <div key={f.key} className="flex items-center justify-between text-xs text-zinc-500">
            <span>{f.label}</span>
            <span className="text-zinc-700">{String(v)}</span>
          </div>
        )
      })}
    </div>
  )

  return entity.linkPrefix && item.id ? <Link href={`${entity.linkPrefix}/${item.id}`}>{body}</Link> : body
}

function ConditionEditor({
  field, draft, setDraft, onAutoApply, options, optionsLoading, onSearchOptions, onConfirm, onCancel,
}: {
  field: FieldConfig
  draft: DraftCondition
  setDraft: (d: DraftCondition) => void
  onAutoApply: (d: DraftCondition) => void
  options: { value: string; label: string }[]
  optionsLoading: boolean
  onSearchOptions: (q: string) => void
  onConfirm: () => void
  onCancel: () => void
}) {
  const operators = OPERATORS_BY_TYPE[field.type]
  const needsNoValue = ['is_empty', 'is_not_empty', 'is_true', 'is_false'].includes(draft.operator)
  const isMulti = draft.operator === 'is_any_of'
  const isBetween = draft.operator === 'between'

  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-3 space-y-3 max-w-sm">
      <div className="text-sm font-medium text-zinc-800">{field.label}</div>

      {operators.length > 1 && (
        <select
          value={draft.operator}
          onChange={e => {
            const operator = e.target.value as Operator
            const next = { ...draft, operator }
            setDraft(next)
            if (['is_empty', 'is_not_empty', 'is_true', 'is_false'].includes(operator)) onAutoApply(next)
          }}
          className="w-full rounded-md border border-zinc-200 px-2.5 py-1.5 text-sm"
        >
          {operators.map(op => (
            <option key={op} value={op}>{OPERATOR_LABELS[op]}</option>
          ))}
        </select>
      )}

      {!needsNoValue && (field.type === 'select' || field.type === 'reference') && (
        <div className="space-y-1.5">
          <input
            placeholder="Search…"
            onChange={e => onSearchOptions(e.target.value)}
            className="w-full rounded-md border border-zinc-200 px-2.5 py-1.5 text-sm"
          />
          <div className="max-h-40 overflow-y-auto space-y-1">
            {optionsLoading ? (
              <div className="text-xs text-zinc-400 py-1">Loading…</div>
            ) : options.length === 0 ? (
              <div className="text-xs text-zinc-400 py-1">No values found.</div>
            ) : options.map(opt => (
              <label key={String(opt.value)} className="flex items-center gap-2 text-sm text-zinc-700">
                <input
                  type="checkbox"
                  checked={draft.values.includes(String(opt.value))}
                  onChange={e => {
                    const v = String(opt.value)
                    const values = e.target.checked ? [...draft.values, v] : draft.values.filter(x => x !== v)
                    const next = { ...draft, values }
                    setDraft(next)
                    if (values.length > 0) onAutoApply(next)
                  }}
                />
                {opt.label}
              </label>
            ))}
          </div>
        </div>
      )}

      {!needsNoValue && !isMulti && field.type === 'text' && (
        <input
          autoFocus
          value={draft.value}
          onChange={e => setDraft({ ...draft, value: e.target.value })}
          onBlur={() => onAutoApply(draft)}
          onKeyDown={e => e.key === 'Enter' && onAutoApply(draft)}
          className="w-full rounded-md border border-zinc-200 px-2.5 py-1.5 text-sm"
        />
      )}

      {!needsNoValue && !isMulti && field.type === 'number' && (
        <div className="flex items-center gap-2">
          <input
            type="number"
            value={draft.value}
            onChange={e => setDraft({ ...draft, value: e.target.value })}
            onBlur={() => !isBetween && onAutoApply(draft)}
            onKeyDown={e => e.key === 'Enter' && onAutoApply(draft)}
            className="w-full rounded-md border border-zinc-200 px-2.5 py-1.5 text-sm"
          />
          {isBetween && (
            <>
              <span className="text-xs text-zinc-400">and</span>
              <input
                type="number"
                value={draft.value2}
                onChange={e => setDraft({ ...draft, value2: e.target.value })}
                onBlur={() => onAutoApply(draft)}
                onKeyDown={e => e.key === 'Enter' && onAutoApply(draft)}
                className="w-full rounded-md border border-zinc-200 px-2.5 py-1.5 text-sm"
              />
            </>
          )}
        </div>
      )}

      {!needsNoValue && field.type === 'date' && (
        <div className="flex items-center gap-2">
          <input
            type="date"
            value={draft.value}
            onChange={e => {
              const next = { ...draft, value: e.target.value }
              setDraft(next)
              if (!isBetween && next.value) onAutoApply(next)
            }}
            className="w-full rounded-md border border-zinc-200 px-2.5 py-1.5 text-sm"
          />
          {isBetween && (
            <>
              <span className="text-xs text-zinc-400">and</span>
              <input
                type="date"
                value={draft.value2}
                onChange={e => {
                  const next = { ...draft, value2: e.target.value }
                  setDraft(next)
                  if (next.value && next.value2) onAutoApply(next)
                }}
                className="w-full rounded-md border border-zinc-200 px-2.5 py-1.5 text-sm"
              />
            </>
          )}
        </div>
      )}

      <div className="flex items-center gap-2 pt-1">
        {(needsNoValue || (field.type !== 'text' && field.type !== 'number')) ? null : (
          <button onClick={onConfirm} className="inline-flex items-center gap-1 rounded-md bg-zinc-900 text-white px-3 py-1.5 text-xs font-medium hover:bg-zinc-700">
            <Search className="h-3 w-3" /> Apply now
          </button>
        )}
        <button onClick={onCancel} className="text-xs text-zinc-400 hover:text-zinc-600">Cancel</button>
      </div>
    </div>
  )
}
