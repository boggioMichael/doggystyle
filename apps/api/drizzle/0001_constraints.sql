-- ─────────────────────────────────────────────────────────────────────────────
-- Hand-written invariants. These belong in the database, not only in service
-- code, so that no code path (including a future bug, a migration script, or a
-- direct psql session) can violate them.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS cube;
CREATE EXTENSION IF NOT EXISTS earthdistance;
--> statement-breakpoint

-- ── ADR 0006: sensitive attributes may never come from a model ───────────────
ALTER TABLE dog_profile_attributes
  ADD CONSTRAINT dog_attr_sensitive_source_ck
  CHECK (sensitive = false OR source IN ('user', 'verified_document'));
--> statement-breakpoint

ALTER TABLE dog_profile_attributes
  ADD CONSTRAINT dog_attr_source_ck
  CHECK (source IN ('vision_model','text_model','social_import','user','verified_document','system_default'));
--> statement-breakpoint

ALTER TABLE dog_profile_attributes
  ADD CONSTRAINT dog_attr_confidence_ck
  CHECK (confidence >= 0 AND confidence <= 1);
--> statement-breakpoint

-- ── Enum-ish value domains ──────────────────────────────────────────────────
ALTER TABLE users ADD CONSTRAINT users_role_ck CHECK (role IN ('user','admin'));
--> statement-breakpoint
ALTER TABLE users ADD CONSTRAINT users_status_ck CHECK (status IN ('active','suspended','deleted'));
--> statement-breakpoint
ALTER TABLE users ADD CONSTRAINT users_location_precision_ck
  CHECK (location_precision IN ('city','neighbourhood','exact'));
--> statement-breakpoint

ALTER TABLE dog_profiles ADD CONSTRAINT dog_profiles_sex_ck
  CHECK (sex IN ('male','female','unknown'));
--> statement-breakpoint
ALTER TABLE dog_profiles ADD CONSTRAINT dog_profiles_size_ck
  CHECK (size IS NULL OR size IN ('toy','small','medium','large','giant'));
--> statement-breakpoint
ALTER TABLE dog_profiles ADD CONSTRAINT dog_profiles_activity_ck
  CHECK (activity_level IS NULL OR activity_level IN ('low','moderate','high','very_high'));
--> statement-breakpoint
ALTER TABLE dog_profiles ADD CONSTRAINT dog_profiles_sociability_ck
  CHECK (sociability IS NULL OR sociability IN ('shy','selective','friendly','very_social'));
--> statement-breakpoint
ALTER TABLE dog_profiles ADD CONSTRAINT dog_profiles_visibility_ck
  CHECK (visibility IN ('public','matches_only','hidden'));
--> statement-breakpoint
ALTER TABLE dog_profiles ADD CONSTRAINT dog_profiles_age_ck
  CHECK (age_years IS NULL OR (age_years >= 0 AND age_years <= 30));
--> statement-breakpoint

ALTER TABLE breeding_records ADD CONSTRAINT breeding_repro_ck
  CHECK (reproductive_status IS NULL OR reproductive_status IN ('intact','neutered','spayed','unknown'));
--> statement-breakpoint

ALTER TABLE match_requests ADD CONSTRAINT match_requests_status_ck
  CHECK (status IN ('pending','accepted','declined','withdrawn','expired'));
--> statement-breakpoint
ALTER TABLE meetups ADD CONSTRAINT meetups_status_ck
  CHECK (status IN ('proposed','accepted','declined','cancelled','completed'));
--> statement-breakpoint
ALTER TABLE meetups ADD CONSTRAINT meetups_time_ck CHECK (ends_at > starts_at);
--> statement-breakpoint
ALTER TABLE jobs ADD CONSTRAINT jobs_status_ck
  CHECK (status IN ('pending','running','complete','failed','dead_letter'));
--> statement-breakpoint
ALTER TABLE reports ADD CONSTRAINT reports_status_ck
  CHECK (status IN ('open','reviewing','actioned','dismissed'));
--> statement-breakpoint
ALTER TABLE media_assets ADD CONSTRAINT media_assets_status_ck
  CHECK (status IN ('pending','processed','rejected','duplicate'));
--> statement-breakpoint
ALTER TABLE chat_messages ADD CONSTRAINT chat_messages_role_ck
  CHECK (role IN ('user','assistant','system'));
--> statement-breakpoint

-- ── No self-referential edges ───────────────────────────────────────────────
ALTER TABLE blocks ADD CONSTRAINT blocks_not_self_ck CHECK (blocker_user_id <> blocked_user_id);
--> statement-breakpoint
ALTER TABLE reports ADD CONSTRAINT reports_not_self_ck CHECK (reporter_user_id <> reported_user_id);
--> statement-breakpoint
ALTER TABLE connections ADD CONSTRAINT connections_distinct_users_ck CHECK (user_a_id <> user_b_id);
--> statement-breakpoint
ALTER TABLE connections ADD CONSTRAINT connections_distinct_dogs_ck CHECK (dog_a_id <> dog_b_id);
--> statement-breakpoint
ALTER TABLE dog_connections ADD CONSTRAINT dog_connections_distinct_ck CHECK (dog_a_id <> dog_b_id);
--> statement-breakpoint
ALTER TABLE match_requests ADD CONSTRAINT match_requests_distinct_ck CHECK (from_dog_id <> to_dog_id);
--> statement-breakpoint

-- ── Only ONE pending introduction per dog pair (re-requesting after a decline
--    must stay possible, so the previous blanket unique index is replaced). ──
DROP INDEX IF EXISTS match_requests_pair_pending_uq;
--> statement-breakpoint
CREATE UNIQUE INDEX match_requests_pair_pending_uq
  ON match_requests (from_dog_id, to_dog_id)
  WHERE status = 'pending';
--> statement-breakpoint

-- ── Geo helper index for radius pre-filtering (see modules/matching/filters) ─
CREATE INDEX IF NOT EXISTS dog_profiles_earth_idx
  ON dog_profiles USING gist (ll_to_earth(lat, lng))
  WHERE lat IS NOT NULL AND lng IS NOT NULL;
--> statement-breakpoint

-- ── Soft-delete-aware lookups ───────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS media_assets_live_idx
  ON media_assets (user_id, status) WHERE deleted_at IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS dogs_live_idx ON dogs (owner_id) WHERE deleted_at IS NULL;
--> statement-breakpoint

-- ── Documentation of the highest-risk columns ───────────────────────────────
COMMENT ON COLUMN users.exact_lat IS
  'Opt-in precise latitude. NEVER serialise to any peer-facing DTO. See docs/THREAT_MODEL.md.';
--> statement-breakpoint
COMMENT ON COLUMN users.exact_lng IS
  'Opt-in precise longitude. NEVER serialise to any peer-facing DTO. See docs/THREAT_MODEL.md.';
--> statement-breakpoint
COMMENT ON COLUMN dog_profile_attributes.sensitive IS
  'True for health/genetic/pedigree/reproductive keys. Enforced by dog_attr_sensitive_source_ck.';
