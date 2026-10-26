-- The Google profile picture shown on the header's account button; null for sessions started before this column.
ALTER TABLE sessions ADD COLUMN picture VARCHAR(512) NULL;
