import { ArrowRight, GitBranch, ImageIcon, Lock, PowerOff, Sparkles, Zap } from 'lucide-react'
import {
  DEFAULT_STEPS_TITLE, NOTE_TAG_LABEL, STEP_FLAG_LABEL, noteDayLabel, screenshotUrl,
  type NoteStep, type NoteTag, type ReleaseNote, type StepFlag,
} from '@/lib/release/release-notes'

const TAG_STYLE: Record<NoteTag, string> = {
  new: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300',
  improved: 'bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300',
  fixed: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300',
  'behind-the-scenes': 'bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300',
}

const FLAG_STYLE: Record<StepFlag, string> = {
  auto: 'bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300',
  locked: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300',
  new: 'bg-emerald-700 text-white dark:bg-emerald-300 dark:text-emerald-950',
  off: 'bg-zinc-200 text-zinc-700 dark:bg-zinc-700 dark:text-zinc-200',
}

const FLAG_ICON: Record<StepFlag, typeof Lock> = { auto: Zap, locked: Lock, new: Sparkles, off: PowerOff }

function FlagChip({ flag }: { flag: StepFlag }) {
  const Icon = FLAG_ICON[flag]
  return (
    <span className={`inline-flex items-center gap-1 self-start rounded-md px-1.5 py-0.5 text-[11px] font-semibold leading-tight ${FLAG_STYLE[flag]}`}>
      <Icon className="h-3 w-3" aria-hidden="true" />
      {STEP_FLAG_LABEL[flag]}
    </span>
  )
}

/** The process diagram: one box per step, an arrow between them. Boxes sit side by side on a wide screen and stack on a phone. */
function StepsDiagram({ steps }: { steps: NoteStep[] }) {
  return (
    <ol className="grid gap-5 md:grid-flow-col md:auto-cols-fr" data-release-steps="">
      {steps.map((s, i) => (
        <li
          key={i}
          className={`relative flex min-w-0 flex-col gap-1.5 rounded-lg border p-2.5 ${s.flag === 'new' ? 'border-2 border-emerald-700 bg-emerald-50 dark:border-emerald-400 dark:bg-emerald-950' : 'bg-muted/50'}`}
        >
          <span className="text-[13px] font-semibold leading-tight">{s.name}</span>
          {s.flag && <FlagChip flag={s.flag} />}
          {s.detail && <span className="text-xs leading-snug text-muted-foreground">{s.detail}</span>}
          {i < steps.length - 1 && (
            <>
              <svg aria-hidden="true" viewBox="0 0 20 12" className="absolute -right-5 top-1/2 hidden h-3 w-5 -translate-y-1/2 text-muted-foreground md:block" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M1 6h15M12 1.5 17 6l-5 4.5" /></svg>
              <svg aria-hidden="true" viewBox="0 0 12 20" className="absolute -bottom-5 left-5 h-5 w-3 text-muted-foreground md:hidden" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 1v15M1.5 12 6 17l4.5-5" /></svg>
            </>
          )}
        </li>
      ))}
    </ol>
  )
}

/** The same diagram, smaller, for the update bar's panel: short chips in a row that wraps. */
function StepsMini({ steps }: { steps: NoteStep[] }) {
  return (
    <ol className="flex flex-wrap items-center gap-1.5" data-release-steps-mini="">
      {steps.map((s, i) => {
        const Icon = s.flag ? FLAG_ICON[s.flag] : null
        const emphasis = s.flag === 'new' ? 'border-emerald-700 bg-emerald-50 text-emerald-900 dark:border-emerald-400 dark:bg-emerald-950 dark:text-emerald-200' : 'bg-muted/50'
        return (
          <li key={i} className="flex items-center gap-1.5">
            <span className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] font-semibold ${emphasis}`} title={s.flag ? STEP_FLAG_LABEL[s.flag] : undefined}>
              {Icon && <Icon className="h-2.5 w-2.5 shrink-0" aria-hidden="true" />}
              {s.name}
            </span>
            {i < steps.length - 1 && <ArrowRight className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden="true" />}
          </li>
        )
      })}
    </ol>
  )
}

const VISUAL_LABEL = 'mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-blue-600 dark:text-blue-400'

/**
 * One release note: a tag, the title, what it does in plain English, optional "what to try" lines, a process diagram and a picture.
 * Shared by the update bar's panel (compact: the diagram is a row of small chips) and the Releases page.
 * Every release shows what it does with a picture or a diagram (Antonio 2026-11-12) unless nobody can see it (behind-the-scenes).
 */
export function ReleaseNoteCard({ note, showDay = false, compact = false }: { note: ReleaseNote; showDay?: boolean; compact?: boolean }) {
  const hasSteps = note.steps.length > 0
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
      {hasSteps && (
        <div className="mt-3">
          <div className={VISUAL_LABEL}><GitBranch className="h-3.5 w-3.5" aria-hidden="true" />{note.stepsTitle ?? DEFAULT_STEPS_TITLE}</div>
          {compact ? <StepsMini steps={note.steps} /> : <StepsDiagram steps={note.steps} />}
        </div>
      )}
      {note.screenshot && (
        <div className="mt-3">
          <div className={VISUAL_LABEL}><ImageIcon className="h-3.5 w-3.5" aria-hidden="true" />Screenshot</div>
          {/* eslint-disable-next-line @next/next/no-img-element -- a static picture from public/release-notes/, shown at its natural size */}
          <img src={screenshotUrl(note.screenshot)} alt={`Screenshot: ${note.title}`} loading="lazy" className="h-auto w-full rounded-md border" />
        </div>
      )}
    </article>
  )
}
