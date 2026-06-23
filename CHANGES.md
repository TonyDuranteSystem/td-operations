# WhatsApp Import + Inbox WhatsApp Tab — Changes

## Files Changed

### New files
| File | Description |
|------|-------------|
| `scripts/import-whatsapp.ts` | Standalone import script — reads WA_Export folder from Google Drive, parses .txt exports, matches phones to CRM contacts/leads, upserts messaging_groups, inserts messages, writes import-report.json |
| `app/api/inbox/whatsapp/conversations/route.ts` | GET endpoint — returns WhatsApp conversations from messaging_groups + latest message preview |
| `app/api/inbox/whatsapp/messages/[groupId]/route.ts` | GET endpoint — returns all messages for a WhatsApp group ordered by created_at ASC |
| `components/inbox/whatsapp-thread.tsx` | Read-only WhatsApp chat bubble UI — inbound (grey/left), outbound (green/right), media shown as italic placeholder |

### Modified files
| File | What changed |
|------|-------------|
| `lib/types.ts` | Added `'whatsapp'` to `InboxChannel` union; added `whatsapp: number` to `InboxStats` |
| `app/api/inbox/stats/route.ts` | Now fetches WhatsApp unread count from messaging_groups in parallel with Gmail; includes `whatsapp` and updated `total` in response |
| `components/inbox/inbox-header.tsx` | Added WhatsApp tab with green MessageSquare icon; shows unread badge from stats endpoint |
| `components/inbox/conversation-list.tsx` | Added `whatsapp` to channelIcons/channelColors; when channel is `whatsapp`, fetches from `/api/inbox/whatsapp/conversations` instead of the Gmail endpoint; hides checkboxes for WhatsApp |
| `components/inbox/inbox-shell.tsx` | Added `whatsapp` to channelIcons/channelLabels; hides mailbox selector, search bar, and bulk actions for WhatsApp; renders `<WhatsappThread>` instead of MessageThread+ComposeReply when selected conversation is WhatsApp; hides all action buttons (Reply, AI Assist, Archive, etc.) for WhatsApp (read-only) |
| `package.json` | Added `"import-whatsapp": "npx tsx scripts/import-whatsapp.ts"` to scripts |

## Key facts verified from database.types.ts
- `messaging_channels` discriminator column = **`platform`** (not `channel_type`)
- `messages` timestamp column = **`created_at`** (not `inserted_at`)
- `messaging_groups` has: `lead_id`, `unread_count`, `last_message_at`, `external_group_id`
- `messages` has: `content_text`, `content_type`, `direction`, `sender_name`, `sender_phone`, `status`, `external_message_id`

## Periskope references in existing code
One comment in `lib/mcp/tools/messaging.ts` line 5 (not changed — pre-existing, documentation only).

## How to run the import
```bash
npm run import-whatsapp
```
Reads from Google Drive `WA_Export` folder, writes `import-report.json` to project root.

## Sandbox tested
- Build: ✅ passes
- ESLint: ✅ zero warnings
- Unit tests: ✅ 3598 passed (276 test files)
