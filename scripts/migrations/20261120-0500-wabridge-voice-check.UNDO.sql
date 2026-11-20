-- Undo: the weekly test and its state are dropped (nothing else reads these columns; the code tolerates them missing).
ALTER TABLE public.wa_bridge_state DROP COLUMN IF EXISTS voice_check;
ALTER TABLE public.wa_bridge_state DROP COLUMN IF EXISTS voice_check_group_id;
