'use client'

import { useState, useMemo } from 'react'
import { ChevronLeft, ChevronRight, Calendar, Clock, CheckCircle2, AlertCircle } from 'lucide-react'
import { cn } from '@/lib/utils'
import { format, parseISO, startOfMonth, endOfMonth, eachDayOfInterval, isSameMonth, isToday, isSameDay, addMonths, subMonths, differenceInDays } from 'date-fns'
import { useLocale } from '@/lib/portal/use-locale'

interface Deadline {
  id: string
  deadline_type: string
  due_date: string
  status: string
  notes: string | null
  state: string | null
  year: number | null
  filed_date: string | null
}

const STATUS_COLORS: Record<string, string> = {
  'Pending': 'bg-amber-500',
  'Overdue': 'bg-red-500',
  'Filed': 'bg-emerald-500',
  'Completed': 'bg-emerald-500',
}

const STATUS_BADGE: Record<string, string> = {
  'Pending': 'bg-amber-100 text-amber-700',
  'Overdue': 'bg-red-100 text-red-700',
  'Filed': 'bg-emerald-100 text-emerald-700',
  'Completed': 'bg-emerald-100 text-emerald-700',
}

export function DeadlineCalendar({ deadlines }: { deadlines: Deadline[] }) {
  const { t } = useLocale()
  const [currentMonth, setCurrentMonth] = useState(new Date())
  const [view, setView] = useState<'calendar' | 'list'>('calendar')
  const [selectedDate, setSelectedDate] = useState<Date | null>(null)

  const monthStart = startOfMonth(currentMonth)
  const monthEnd = endOfMonth(currentMonth)
  const days = eachDayOfInterval({ start: monthStart, end: monthEnd })

  // Pad to start on Monday
  const startDay = monthStart.getDay()
  const paddingDays = startDay === 0 ? 6 : startDay - 1

  const deadlinesByDate = useMemo(() => {
    const map: Record<string, Deadline[]> = {}
    for (const d of deadlines) {
      if (!d.due_date) continue
      const key = d.due_date.split('T')[0]
      if (!map[key]) map[key] = []
      map[key].push(d)
    }
    return map
  }, [deadlines])

  const today = new Date()
  const upcomingDeadlines = deadlines
    .filter(d => d.status !== 'Filed' && d.status !== 'Completed')
    .sort((a, b) => (a.due_date ?? '').localeCompare(b.due_date ?? ''))

  const selectedDateDeadlines = selectedDate
    ? (deadlinesByDate[format(selectedDate, 'yyyy-MM-dd')] ?? [])
    : []

  return (
    <div className="space-y-6">
      {/* Summary Cards */}
      <div className="grid grid-cols-3 gap-3">
        <div className="bg-white rounded-xl border shadow-sm p-4 text-center">
          <p className="text-2xl font-bold text-zinc-900">{deadlines.length}</p>
          <p className="text-xs text-zinc-500">{t('deadlines.total') || 'Total'}</p>
        </div>
        <div className="bg-white rounded-xl border shadow-sm p-4 text-center">
          <p className="text-2xl font-bold text-amber-600">
            {deadlines.filter(d => d.status === 'Pending').length}
          </p>
          <p className="text-xs text-zinc-500">{t('deadlines.pending') || 'Pending'}</p>
        </div>
        <div className="bg-white rounded-xl border shadow-sm p-4 text-center">
          <p className="text-2xl font-bold text-red-600">
            {deadlines.filter(d => d.status === 'Overdue').length}
          </p>
          <p className="text-xs text-zinc-500">{t('deadlines.overdue') || 'Overdue'}</p>
        </div>
      </div>

      {/* View Toggle */}
      <div className="flex items-center justify-between">
        <div className="flex gap-1 bg-zinc-100 p-1 rounded-lg">
          <button
            onClick={() => setView('calendar')}
            className={cn('px-3 py-1.5 text-xs rounded-md transition-colors',
              view === 'calendar' ? 'bg-white shadow text-zinc-900 font-medium' : 'text-zinc-500'
            )}
          >
            <Calendar className="h-3.5 w-3.5 inline mr-1" />
            {t('deadlines.calendarView') || 'Calendar'}
          </button>
          <button
            onClick={() => setView('list')}
            className={cn('px-3 py-1.5 text-xs rounded-md transition-colors',
              view === 'list' ? 'bg-white shadow text-zinc-900 font-medium' : 'text-zinc-500'
            )}
          >
            {t('deadlines.listView') || 'List'}
          </button>
        </div>
      </div>

      {view === 'calendar' ? (
        <div className="bg-white rounded-xl border shadow-sm p-6">
          {/* Month Navigation */}
          <div className="flex items-center justify-between mb-6">
            <button onClick={() => setCurrentMonth(subMonths(currentMonth, 1))} className="p-2 rounded-lg hover:bg-zinc-100">
              <ChevronLeft className="h-5 w-5" />
            </button>
            <h2 className="text-lg font-semibold text-zinc-900">
              {format(currentMonth, 'MMMM yyyy')}
            </h2>
            <button onClick={() => setCurrentMonth(addMonths(currentMonth, 1))} className="p-2 rounded-lg hover:bg-zinc-100">
              <ChevronRight className="h-5 w-5" />
            </button>
          </div>

          {/* Day Headers */}
          <div className="grid grid-cols-7 gap-1 mb-2">
            {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(d => (
              <div key={d} className="text-center text-xs font-medium text-zinc-400 py-2">{d}</div>
            ))}
          </div>

          {/* Calendar Grid */}
          <div className="grid grid-cols-7 gap-1">
            {/* Padding for start of month */}
            {Array.from({ length: paddingDays }).map((_, i) => (
              <div key={`pad-${i}`} className="h-20" />
            ))}

            {days.map(day => {
              const dateKey = format(day, 'yyyy-MM-dd')
              const dayDeadlines = deadlinesByDate[dateKey] ?? []
              const isSelected = selectedDate && isSameDay(day, selectedDate)

              return (
                <button
                  key={dateKey}
                  onClick={() => setSelectedDate(isSelected ? null : day)}
                  className={cn(
                    'h-20 rounded-lg border p-1.5 text-left transition-colors relative',
                    isToday(day) && 'border-blue-300 bg-blue-50/50',
                    isSelected && 'border-blue-500 ring-2 ring-blue-200',
                    !isToday(day) && !isSelected && 'hover:bg-zinc-50 border-transparent',
                  )}
                >
                  <span className={cn(
                    'text-xs font-medium',
                    isToday(day) ? 'text-blue-700' : 'text-zinc-700'
                  )}>
                    {format(day, 'd')}
                  </span>
                  {dayDeadlines.length > 0 && (
                    <div className="flex flex-wrap gap-0.5 mt-1">
                      {dayDeadlines.slice(0, 3).map(d => (
                        <div
                          key={d.id}
                          className={cn('w-1.5 h-1.5 rounded-full', STATUS_COLORS[d.status] ?? 'bg-zinc-400')}
                          title={d.deadline_type}
                        />
                      ))}
                      {dayDeadlines.length > 3 && (
                        <span className="text-[9px] text-zinc-400">+{dayDeadlines.length - 3}</span>
                      )}
                    </div>
                  )}
                </button>
              )
            })}
          </div>

          {/* Selected Date Details */}
          {selectedDate && selectedDateDeadlines.length > 0 && (
            <div className="mt-4 pt-4 border-t space-y-2">
              <h3 className="text-sm font-medium text-zinc-700">
                {format(selectedDate, 'EEEE, MMMM d, yyyy')}
              </h3>
              {selectedDateDeadlines.map(d => (
                <div key={d.id} className="flex items-center gap-3 p-3 rounded-lg bg-zinc-50">
                  <div className={cn('w-2 h-2 rounded-full shrink-0', STATUS_COLORS[d.status] ?? 'bg-zinc-400')} />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-zinc-900">{d.deadline_type}</p>
                    {d.notes && <p className="text-xs text-zinc-500 mt-0.5">{d.notes}</p>}
                  </div>
                  <span className={cn('text-xs px-2 py-0.5 rounded-full', STATUS_BADGE[d.status] ?? 'bg-zinc-100')}>
                    {d.status}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      ) : (
        /* List View */
        <div className="bg-white rounded-xl border shadow-sm divide-y">
          {upcomingDeadlines.length === 0 ? (
            <div className="p-8 text-center">
              <CheckCircle2 className="h-10 w-10 text-emerald-300 mx-auto mb-2" />
              <p className="text-sm text-zinc-500">{t('deadlines.allClear') || 'All deadlines are up to date!'}</p>
            </div>
          ) : (
            upcomingDeadlines.map(d => {
              const daysUntil = d.due_date ? differenceInDays(parseISO(d.due_date), today) : 0
              const isOverdue = daysUntil < 0
              return (
                <div key={d.id} className="p-4 flex items-center gap-4">
                  <div className={cn(
                    'w-10 h-10 rounded-lg flex items-center justify-center shrink-0',
                    isOverdue ? 'bg-red-50' : daysUntil <= 7 ? 'bg-amber-50' : 'bg-zinc-50'
                  )}>
                    {isOverdue
                      ? <AlertCircle className="h-5 w-5 text-red-500" />
                      : <Clock className="h-5 w-5 text-amber-500" />
                    }
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-zinc-900">{d.deadline_type}</p>
                    <p className="text-xs text-zinc-500">
                      {d.due_date && format(parseISO(d.due_date), 'MMM d, yyyy')}
                      {d.state && ` · ${d.state}`}
                    </p>
                    {d.notes && <p className="text-xs text-zinc-400 mt-0.5">{d.notes}</p>}
                  </div>
                  <div className="text-right shrink-0">
                    <span className={cn('text-xs px-2 py-0.5 rounded-full', STATUS_BADGE[d.status] ?? 'bg-zinc-100')}>
                      {d.status}
                    </span>
                    <p className={cn('text-xs mt-1 font-medium',
                      isOverdue ? 'text-red-600' : daysUntil <= 7 ? 'text-amber-600' : 'text-zinc-500'
                    )}>
                      {isOverdue ? `${Math.abs(daysUntil)}d overdue` : daysUntil === 0 ? 'Today' : `${daysUntil}d left`}
                    </p>
                  </div>
                </div>
              )
            })
          )}
        </div>
      )}
    </div>
  )
}
