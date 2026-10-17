-- 0011 menu preferences: each person's left menu order and whether it is collapsed.
-- nav_order is a short list of menu item names (letters only). NULL means the standard order.

ALTER TABLE user_preference
  ADD COLUMN nav_order text[]
    CHECK (nav_order IS NULL OR (cardinality(nav_order) BETWEEN 1 AND 12 AND array_to_string(nav_order, ',') ~ '^[a-z]{1,20}(,[a-z]{1,20})*$')),
  ADD COLUMN nav_collapsed boolean NOT NULL DEFAULT false;
