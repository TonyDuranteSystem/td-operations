-- UNDO for 20261029-2100-marketing-chat-lanes.sql. Drops the lane column and the two lane tables (the messages themselves stay, all in one chat again). Run only on purpose, and only after the code that uses lanes is rolled back.
DROP TABLE IF EXISTS marketing_lead_lane_reads;
DROP TABLE IF EXISTS marketing_lead_lane_delivery;
DROP INDEX IF EXISTS idx_marketing_lead_messages_lane;
ALTER TABLE marketing_lead_messages DROP COLUMN IF EXISTS lane;
