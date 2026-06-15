-- Add a per-stage custom client notification message to pipeline_stages.
-- When set on a stage that also has notify_client_email=true, the stage-advance
-- email (lib/portal/notifications.ts::notifyClientOfStageAdvance, fired by
-- advanceServiceDelivery) uses this text as the email body instead of the
-- generic "Your service X has moved to the Y stage" copy.
--
-- Locale-agnostic for now (one text shown to all recipients). A *_it variant can
-- be added later if Italian clients need a translated override.
ALTER TABLE pipeline_stages
  ADD COLUMN IF NOT EXISTS client_notification_message text;

COMMENT ON COLUMN pipeline_stages.client_notification_message IS
  'Optional custom body for the stage-advance client email (used when notify_client_email=true). Null = generic stage-moved copy.';
