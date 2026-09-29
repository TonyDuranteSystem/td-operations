'use client'

/** What "Check contents" found in a copy (job 685467b5): what the system read inside each file next to its current
 *  type, and possible duplicate pairs. Read-only display — nothing here changes a file. */

export interface ContentFile { fileId: string; name: string; folder: string | null; currentType: string | null; suggestedType: string | null; verdict: 'agree' | 'differ' | 'new' | 'unknown'; converted: boolean; words: number; snippet: string; problem: string | null }
export interface ContentPair { a: { name: string; folder: string | null }; b: { name: string; folder: string | null }; kind: string; note: string; differences: { onlyInA: string[]; onlyInB: string[] }[] }
export interface ContentReportData { files: ContentFile[]; pairs: ContentPair[]; unread: number; budgetHit: boolean }

export function ContentsReport({ title, data, onClose }: { title: string; data: ContentReportData; onClose: () => void }) {
  return (
    <div className="mt-2 max-h-72 overflow-y-auto rounded-md border border-zinc-200 bg-white p-3 text-xs text-zinc-700" data-testid="contents-report">
      <div className="flex items-center">
        <p className="font-medium text-zinc-800">What the system read inside each file — {title}{data.budgetHit ? ' (time ran out — press Check contents again for the rest)' : ''}</p>
        <button type="button" onClick={onClose} className="ml-auto rounded-md border border-zinc-300 px-2 py-0.5 hover:bg-zinc-50">Close</button>
      </div>
      <ul className="mt-1 space-y-1">
        {data.files.map((f) => (
          <li key={f.fileId} className="rounded border border-zinc-100 p-1.5">
            <span className="font-medium">{f.name}</span> <span className="text-zinc-500">in {f.folder ?? '—'}</span>{f.converted && <span className="text-zinc-500"> · photo converted to read it</span>}
            <div>
              Now: <strong>{f.currentType ?? 'no type'}</strong> · System thinks: <strong>{f.suggestedType ?? 'nothing'}</strong>{' '}
              {f.verdict === 'agree' && <span className="text-emerald-700">✓ same</span>}
              {f.verdict === 'differ' && <span className="text-amber-700">⚠ different — please look</span>}
              {f.verdict === 'new' && <span className="text-blue-700">new suggestion</span>}
            </div>
            {f.problem ? <div className="text-amber-700">{f.problem}</div> : <div className="text-zinc-500">{f.words} words · “{f.snippet}…”</div>}
          </li>
        ))}
      </ul>
      <p className="mt-2 font-medium text-zinc-800">Possible duplicates</p>
      {data.pairs.length === 0 ? <p className="text-zinc-500">None found.</p> : (
        <ul className="mt-1 space-y-1">
          {data.pairs.map((p, i) => (
            <li key={i} className="rounded border border-zinc-100 p-1.5">
              <span className="font-medium">{p.a.name}</span> ({p.a.folder ?? '—'}) ↔ <span className="font-medium">{p.b.name}</span> ({p.b.folder ?? '—'})
              <div className={p.kind === 'same_bytes' || p.kind === 'same_words' ? 'text-emerald-700' : 'text-amber-700'}>{p.note}</div>
              {p.differences.slice(0, 5).map((d, k) => <div key={k} className="text-zinc-500">{d.onlyInA.length ? `only in the first: “${d.onlyInA.join(' ')}” ` : ''}{d.onlyInB.length ? `only in the second: “${d.onlyInB.join(' ')}”` : ''}</div>)}
            </li>
          ))}
        </ul>
      )}
      <p className="mt-2 text-zinc-500">Nothing was changed. Tell me what is right and what is wrong, and the rules are made from that.</p>
    </div>
  )
}
