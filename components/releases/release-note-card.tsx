import { NOTE_TAG_LABEL, noteDayLabel, screenshotUrl, type NoteTag, type ReleaseNote } from '@/lib/release/release-notes'

const TAG_STYLE: Record<NoteTag, string> = {
  new: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300',
  improved: 'bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300',
  fixed: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300',
  'behind-the-scenes': 'bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300',
}

/** One release note: a tag, the title, what it does in plain English, optional "what to try" lines and a picture. Shared by the update bar's panel and the Releases page. */
export function ReleaseNoteCard({ note, showDay = false }: { note: ReleaseNote; showDay?: boolean }) {
  return (
    <article className="rounded-lg border bg-card p-4 text-card-foreground" data-release-note={note.id}>
      <div className="flex flex-wrap items-center gap-2">
        <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${TAG_STYLE[note.tag]}`}>{NOTE_TAG_LABEL[note.tag]}</span>
        {showDay && <span className="text-xs text-muted-foreground">{noteDayLabel(note.id)}</span>}
      </div>
      <h3 className="mt-2 text-sm font-semibold leading-snug">{note.title}</h3>
      <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{note.text}</p>
      {note.points.length > 0 && (
        <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-muted-foreground">
          {note.points.map((p, i) => <li key={i}>{p}</li>)}
        </ul>
      )}
      {note.screenshot && (
        // eslint-disable-next-line @next/next/no-img-element -- a static picture from public/release-notes/, shown at its natural size
        <img src={screenshotUrl(note.screenshot)} alt={`Screenshot: ${note.title}`} loading="lazy" className="mt-3 h-auto w-full rounded-md border" />
      )}
    </article>
  )
}
