import { z } from "zod"
import { TASK_STATUS, TASK_PRIORITY, TASK_CATEGORY } from "@/lib/constants"

export const createTaskSchema = z.object({
  task_title: z.string().min(1, "Title is required").max(200),
  description: z.string().max(2000).optional(),
  priority: z.enum(TASK_PRIORITY).default("Normal"),
  category: z.enum(TASK_CATEGORY).optional(),
  assigned_to: z.enum(["Antonio", "Luca"]).default("Luca"),
  due_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid date format")
    .optional(),
  account_id: z.string().uuid().optional(),
  status: z.enum(TASK_STATUS).default("To Do"),
})

export const updateTaskSchema = createTaskSchema.partial().extend({
  id: z.string().uuid(),
  updated_at: z.string(), // for optimistic locking
})

export type CreateTaskInput = z.infer<typeof createTaskSchema>
export type UpdateTaskInput = z.infer<typeof updateTaskSchema>
