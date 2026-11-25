-- Migration 0003: AURA proposals and quota ledger (hito 400, contracts 1.10.0).
-- Must match 05_DATABASE/core_reference.sql (test/schema.test.mjs). Roll-forward only.
SET search_path TO aurea,public;
-- A revision accepted from an AURA proposal records source AI and the proposal id.
ALTER TABLE revision DROP CONSTRAINT revision_source_check;
ALTER TABLE revision ADD CONSTRAINT revision_source_check CHECK(source IN ('CREATE','PREVIEW','SYNC','AI'));
-- The prompt itself is not stored: only its SHA-256 and length (SYSTEM_PROMPTS.md, privacy).
CREATE TABLE ai_proposal(id uuid PRIMARY KEY, actor text NOT NULL, project_id uuid NOT NULL REFERENCES project, base_revision_id uuid NOT NULL, state text NOT NULL DEFAULT 'PROPOSED' CHECK(state IN ('PROPOSED','PREVIEWING','ACCEPTED','DISCARDED','EXPIRED')), provider text NOT NULL, model text NOT NULL, simulated boolean NOT NULL, prompt_sha256 char(64) NOT NULL CHECK(prompt_sha256 ~ '^[0-9a-f]{64}$'), prompt_chars int NOT NULL CHECK(prompt_chars BETWEEN 1 AND 2000), locale text NOT NULL CHECK(locale IN ('es','en')), result jsonb NOT NULL CHECK(jsonb_typeof(result)='object'), preview_option int CHECK(preview_option >= 0), preview_job_id uuid REFERENCES job, revision_id uuid, created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL, FOREIGN KEY(project_id,base_revision_id) REFERENCES revision(project_id,id), FOREIGN KEY(project_id,revision_id) REFERENCES revision(project_id,id), CHECK(state <> 'ACCEPTED' OR revision_id IS NOT NULL), CHECK(state <> 'PREVIEWING' OR preview_job_id IS NOT NULL));
CREATE INDEX ai_proposal_project ON ai_proposal(project_id,created_at DESC);
-- Quota ledger, append-only: used = RESERVE − RELEASE per actor and UTC day; SPEND confirms a reserve.
CREATE TABLE ai_usage(id uuid PRIMARY KEY, actor text NOT NULL, day date NOT NULL, entry text NOT NULL CHECK(entry IN ('RESERVE','SPEND','RELEASE')), units int NOT NULL CHECK(units > 0), request_id uuid NOT NULL, provider text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(request_id,entry));
CREATE INDEX ai_usage_actor_day ON ai_usage(actor,day);
CREATE FUNCTION ai_usage_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'ai_usage is append-only' USING ERRCODE = 'check_violation';
END $$;
CREATE TRIGGER ai_usage_append_only BEFORE UPDATE OR DELETE ON ai_usage FOR EACH ROW EXECUTE FUNCTION ai_usage_append_only();
