import { createClient } from '@/lib/supabase/server'
import { TaskKanban } from '@/components/tasks/task-kanban'
import type { Task, TaskStats } from '@/lib/types'

export default async function TasksPage() {
  const supabase = createClient()
  const today = new Date().toISOString().split('T')[0]

  // Fetch active tasks (all except Done)
  const { data: activeTasks } = await supabase
    .from('tasks')
    .select('id, task_title, status, priority, due_date, assigned_to, category, description, account_id, updated_at, created_at')
    .in('status', ['To Do', 'In Progress', 'Waiting'])
    .order('due_date', { ascending: true, nullsFirst: false })

  // Fetch recent Done tasks (limit 50)
  const { data: doneTasks } = await supabase
    .from('tasks')
    .select('id, task_title, status, priority, due_date, assigned_to, category, description, account_id, updated_at, created_at')
    .eq('status', 'Done')
    .order('updated_at', { ascending: false })
    .limit(50)

  const rawTasks = [...(activeTasks ?? []), ...(doneTasks ?? [])]

  // Fetch company names for tasks with account_id
  const accountIds = Array.from(new Set(rawTasks.filter(t => t.account_id).map(t => t.account_id)))
  let accountMap: Record<string, string> = {}
  if (accountIds.length > 0) {
    const { data: accounts } = await supabase
      .from('accounts')
      .select('id, company_name')
      .in('id', accountIds)
    if (accounts) {
      accountMap = Object.fromEntries(accounts.map(a => [a.id, a.company_name]))
    }
  }

  const tasks: Task[] = rawTasks.map(t => ({
    ...t,
    company_name: t.account_id ? accountMap[t.account_id] ?? null : null,
  }))

  // Stats (active tasks only, exclude Done)
  const active = tasks.filter(t => t.status !== 'Done')
  const isOverdue = (t: Task) => t.due_date !== null && t.due_date < today

  const stats: TaskStats = {
    total: active.length,
    urgent: active.filter(t => t.priority === 'Urgent' || isOverdue(t)).length,
    waiting: active.filter(t => t.status === 'Waiting').length,
    overdue: active.filter(t => isOverdue(t)).length,
    inProgress: active.filter(t => t.status === 'In Progress').length,
  }

  return (
    <div className="p-6 lg:p-8">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Task Board</h1>
        <p className="text-muted-foreground text-sm mt-1">Daily operational task overview</p>
      </div>
      <TaskKanban tasks={tasks} stats={stats} today={today} />
    </div>
  )
}
