-- Research Console — saved searches now cover one or more record types at
-- once (multi-entity search), not a single entity. Replace the single
-- `entity` column with an `entities` array.

ALTER TABLE research_saved_searches ADD COLUMN IF NOT EXISTS entities TEXT[] NOT NULL DEFAULT '{}';

UPDATE research_saved_searches SET entities = ARRAY[entity] WHERE entity IS NOT NULL AND entities = '{}';

ALTER TABLE research_saved_searches DROP COLUMN IF EXISTS entity;

DROP INDEX IF EXISTS idx_research_saved_searches_entity;
CREATE INDEX IF NOT EXISTS idx_research_saved_searches_entities ON research_saved_searches USING GIN (entities);
