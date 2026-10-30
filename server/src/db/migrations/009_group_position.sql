-- Ordre manuel des groupes dans la liste. L'ordre actuel (alphabétique) est conservé.
ALTER TABLE db_groups ADD COLUMN position INTEGER NOT NULL DEFAULT 0;

UPDATE db_groups
SET position = (
  SELECT COUNT(*) FROM db_groups AS other
  WHERE other.name < db_groups.name
     OR (other.name = db_groups.name AND other.id < db_groups.id)
);
