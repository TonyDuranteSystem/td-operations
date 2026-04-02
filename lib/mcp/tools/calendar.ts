/**
 * Google Calendar MCP Tools
 *
 * 5 tools for managing Antonio's Google Calendar:
 *   calendar_list_events    — List upcoming events
 *   calendar_create_event   — Create a new event
 *   calendar_update_event   — Update an existing event
 *   calendar_delete_event   — Delete an event
 *   calendar_find_free_slots — Find available time slots
 *
 * Auth: Service Account + DWD, impersonating antonio.durante@tonydurante.us
 * Requires calendar scope in Google Workspace Admin DWD settings.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import {
  listEvents,
  createEvent,
  updateEvent,
  deleteEvent,
  findFreeSlots,
} from "@/lib/google-calendar"
import type { CalendarEvent } from "@/lib/google-calendar"

function formatEvent(e: CalendarEvent): string {
  const start = e.start.dateTime
    ? new Date(e.start.dateTime).toLocaleString("en-US", {
        timeZone: "America/New_York",
        weekday: "short",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      })
    : e.start.date || "unknown"

  const end = e.end.dateTime
    ? new Date(e.end.dateTime).toLocaleString("en-US", {
        timeZone: "America/New_York",
        hour: "numeric",
        minute: "2-digit",
      })
    : ""

  let line = `• **${e.summary || "(no title)"}** — ${start}${end ? ` to ${end}` : ""}`
  if (e.location) line += `\n  📍 ${e.location}`
  if (e.attendees?.length) {
    line += `\n  👥 ${e.attendees.map((a) => a.email).join(", ")}`
  }
  if (e.description) {
    const desc = e.description.length > 100 ? e.description.slice(0, 100) + "…" : e.description
    line += `\n  📝 ${desc}`
  }
  line += `\n  ID: ${e.id}`
  return line
}

export function registerCalendarTools(server: McpServer) {

  // ─── calendar_list_events ────────────────────────────────
  server.tool(
    "calendar_list_events",
    "List upcoming Google Calendar events for Antonio. Default shows next 7 days. Use to check schedule before booking meetings or setting deadlines. Timezone: America/New_York.",
    {
      calendar_id: z.string().default("primary").describe("Calendar ID (default: primary)"),
      days_ahead: z.number().default(7).describe("Show events within N days from now (default 7)"),
      max_results: z.number().default(20).describe("Max results (default 20)"),
    },
    async ({ calendar_id, days_ahead, max_results }) => {
      try {
        const events = await listEvents(calendar_id, days_ahead, max_results)

        if (events.length === 0) {
          return {
            content: [{
              type: "text" as const,
              text: `📅 No events in the next ${days_ahead} day(s).`,
            }],
          }
        }

        const lines = events.map(formatEvent)

        return {
          content: [{
            type: "text" as const,
            text: `📅 Upcoming events (${events.length}, next ${days_ahead} days):\n\n${lines.join("\n\n")}`,
          }],
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err)
        return {
          content: [{ type: "text" as const, text: `❌ Error: ${message}` }],
        }
      }
    }
  )

  // ─── calendar_create_event ───────────────────────────────
  server.tool(
    "calendar_create_event",
    "Create a Google Calendar event. Always confirm with Antonio before calling this. Attendees receive Google Calendar invites automatically.",
    {
      summary: z.string().describe("Event title"),
      start_datetime: z.string().describe("Start time as ISO 8601 string (e.g., '2026-04-03T10:00:00')"),
      end_datetime: z.string().describe("End time as ISO 8601 string (e.g., '2026-04-03T11:00:00')"),
      description: z.string().optional().describe("Event description"),
      attendees: z.array(z.string()).optional().describe("Array of attendee email addresses"),
      calendar_id: z.string().default("primary").describe("Calendar ID (default: primary)"),
      location: z.string().optional().describe("Event location"),
    },
    async ({ summary, start_datetime, end_datetime, description, attendees, calendar_id, location }) => {
      try {
        const event = await createEvent(calendar_id, {
          summary,
          start_datetime,
          end_datetime,
          description,
          attendees,
          location,
        })

        return {
          content: [{
            type: "text" as const,
            text: `✅ Event created\n${formatEvent(event)}\n🔗 ${event.htmlLink}`,
          }],
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err)
        return {
          content: [{ type: "text" as const, text: `❌ Error: ${message}` }],
        }
      }
    }
  )

  // ─── calendar_update_event ───────────────────────────────
  server.tool(
    "calendar_update_event",
    "Update an existing calendar event. Only provided fields are changed. Always confirm with Antonio before calling.",
    {
      event_id: z.string().describe("Event ID (from calendar_list_events)"),
      calendar_id: z.string().default("primary").describe("Calendar ID (default: primary)"),
      summary: z.string().optional().describe("New event title"),
      start_datetime: z.string().optional().describe("New start time (ISO 8601)"),
      end_datetime: z.string().optional().describe("New end time (ISO 8601)"),
      description: z.string().optional().describe("New description"),
      attendees: z.array(z.string()).optional().describe("New attendee list (replaces existing)"),
      location: z.string().optional().describe("New location"),
    },
    async ({ event_id, calendar_id, summary, start_datetime, end_datetime, description, attendees, location }) => {
      try {
        const event = await updateEvent(calendar_id, event_id, {
          summary,
          start_datetime,
          end_datetime,
          description,
          attendees,
          location,
        })

        return {
          content: [{
            type: "text" as const,
            text: `✅ Event updated\n${formatEvent(event)}\n🔗 ${event.htmlLink}`,
          }],
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err)
        return {
          content: [{ type: "text" as const, text: `❌ Error: ${message}` }],
        }
      }
    }
  )

  // ─── calendar_delete_event ───────────────────────────────
  server.tool(
    "calendar_delete_event",
    "Delete a calendar event. Always confirm with Antonio before calling.",
    {
      event_id: z.string().describe("Event ID (from calendar_list_events)"),
      calendar_id: z.string().default("primary").describe("Calendar ID (default: primary)"),
    },
    async ({ event_id, calendar_id }) => {
      try {
        await deleteEvent(calendar_id, event_id)

        return {
          content: [{
            type: "text" as const,
            text: `✅ Event deleted (ID: ${event_id})`,
          }],
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err)
        return {
          content: [{ type: "text" as const, text: `❌ Error: ${message}` }],
        }
      }
    }
  )

  // ─── calendar_find_free_slots ────────────────────────────
  server.tool(
    "calendar_find_free_slots",
    "Find free time slots in Antonio's calendar within working hours. Use before scheduling to find available windows. Skips weekends.",
    {
      duration_minutes: z.number().default(60).describe("Required slot duration in minutes (default 60)"),
      days_ahead: z.number().default(5).describe("Search within N days from now (default 5)"),
      working_hours_start: z.number().default(9).describe("Working day starts at (24h, default 9)"),
      working_hours_end: z.number().default(18).describe("Working day ends at (24h, default 18)"),
      timezone: z.string().default("America/New_York").describe("Timezone (default: America/New_York)"),
    },
    async ({ duration_minutes, days_ahead, working_hours_start, working_hours_end, timezone }) => {
      try {
        const slots = await findFreeSlots(
          duration_minutes,
          days_ahead,
          working_hours_start,
          working_hours_end,
          timezone
        )

        if (slots.length === 0) {
          return {
            content: [{
              type: "text" as const,
              text: `📅 No free ${duration_minutes}-minute slots found in the next ${days_ahead} working days (${working_hours_start}:00-${working_hours_end}:00 ${timezone}).`,
            }],
          }
        }

        const lines = slots.map((s) => {
          const start = new Date(s.start).toLocaleString("en-US", {
            timeZone: timezone,
            weekday: "short",
            month: "short",
            day: "numeric",
            hour: "numeric",
            minute: "2-digit",
          })
          const end = new Date(s.end).toLocaleString("en-US", {
            timeZone: timezone,
            hour: "numeric",
            minute: "2-digit",
          })
          return `• ${start} — ${end}`
        })

        return {
          content: [{
            type: "text" as const,
            text: `📅 Free ${duration_minutes}-min slots (next ${days_ahead} working days):\n\n${lines.join("\n")}`,
          }],
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err)
        return {
          content: [{ type: "text" as const, text: `❌ Error: ${message}` }],
        }
      }
    }
  )
}
