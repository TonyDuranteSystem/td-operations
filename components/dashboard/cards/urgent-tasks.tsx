import { createClient } from '@/lib/supabase/server'
import { AlertTriangle, CheckCircle2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import Link from 'next/link'

export async function UrgentTasksCard() {
  const supabase = createClient()
  const today = new Date().toISOString().split('T')[0]

  const { data: tasks } = await supabase
    .from('tasks')
    .select('id, task_title, priority, due_date, assigned_to, status, account_id')
    .in('status', ['To Do', 'In Progress', 'Waiting'])
    .or(`priority.eq.Urgent,due_date.lt.${today}`)
    .order('due_date', { ascending: true, nullsFirst: false })
    .limit(5)

  if (!tasks || tasks.length === 0) {
    return (
      <div className="bg-white rounded-lg border p-5">
        <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-3">
          Urgent Tasks
        </h3>
        <div className="flex flex-col items-center justify-center py-6 text-muted-foreground">
          <CheckCircle2 className="h-8 w-8 mb-2 text-emerald-400" />
          <p className="text-sm">No urgent tasks</p>
        </div>
      </div>
    )
  }

  return (
    <div className="bg-white rounded-lg border p-5">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          Urgent Tasks
        </h3>
        <Link href="/tasks" className="text-xs text-blue-600 hover:underline">
          View all
        </Link>
      </div>
      <div className="space-y-2">
        {tasks.map(task => {
          const overdue = task.due_date && task.due_date < today
          return (
            <div
              key={task.id}
              className={cn(
                'flex items-start gap-2 py-2 px-3 rounded-md text-sm',
                overdue ? 'bg-red-50' : 'bg-amber-50'
              )}
            >
              <AlertTriangle className={cn('h-4 w-4 mt-0.5 shrink-0', overdue ? 'text-red-500' : 'text-amber-500')} />
              <div className="flex-1 min-w-0">
                <p className="font-medium truncate">{task.task_title}</p>
                <p className="text-xs text-muted-foreground">
                  {task.assigned_to} &middot; {overdue ? 'Overdue' : task.priority}
                  {task.due_date && ` \u2022 ${task.due_date}`}
                </p>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
