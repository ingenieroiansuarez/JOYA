-- Migration 0002: design projects, revisions, geometry jobs and offline sync (hito 300, contracts 1.9.0).
-- Must match 05_DATABASE/core_reference.sql (test/schema.test.mjs). Roll-forward only.
-- project and revision existed empty since 0000 (no API wrote them), so NOT NULL columns need no backfill.
SET search_path TO aurea,public;
ALTER TABLE project ADD COLUMN family_id text NOT NULL CHECK(family_id ~ '^[a-z]+\.[a-z0-9]+$');
ALTER TABLE project ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX project_owner_recent ON project(owner_id,updated_at DESC,id);
ALTER TABLE revision ADD CONSTRAINT revision_digest_check CHECK(digest ~ '^[0-9a-f]{64}$');
ALTER TABLE revision ADD COLUMN created_by text NOT NULL;
ALTER TABLE revision ADD COLUMN source text NOT NULL CHECK(source IN ('CREATE','PREVIEW','SYNC'));
ALTER TABLE revision ADD COLUMN source_id uuid;
ALTER TABLE revision ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE revision ADD CONSTRAINT revision_source_id_check CHECK((source = 'CREATE') = (source_id IS NULL));
-- Revisions are immutable: only state may change (machines.json Design). Never deleted.
CREATE FUNCTION revision_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'revision % cannot be deleted', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW.id, NEW.project_id, NEW.parent_id, NEW.number, NEW.document, NEW.digest, NEW.created_by, NEW.source, NEW.source_id, NEW.created_at)
     IS DISTINCT FROM (OLD.id, OLD.project_id, OLD.parent_id, OLD.number, OLD.document, OLD.digest, OLD.created_by, OLD.source, OLD.source_id, OLD.created_at) THEN
    RAISE EXCEPTION 'revision % is immutable', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER revision_immutable BEFORE UPDATE OR DELETE ON revision FOR EACH ROW EXECUTE FUNCTION revision_immutable();
-- Pull cursor: (tx, seq) ordered and read only below the oldest running transaction, so an event
-- committed late by a slow transaction is never skipped.
ALTER TABLE outbox ADD COLUMN seq bigint GENERATED ALWAYS AS IDENTITY;
ALTER TABLE outbox ADD COLUMN tx xid8 NOT NULL DEFAULT pg_current_xact_id();
CREATE INDEX outbox_pull ON outbox(tx,seq);
CREATE TABLE job(id uuid PRIMARY KEY, kind text NOT NULL CHECK(kind IN ('PREVIEW','GEOMETRY','VALIDATION','AI')), state text NOT NULL DEFAULT 'QUEUED' CHECK(state IN ('QUEUED','RUNNING','SUCCEEDED','FAILED','CANCELLED')), actor text NOT NULL, project_id uuid NOT NULL REFERENCES project, revision_id uuid NOT NULL, operation jsonb, document jsonb NOT NULL CHECK(jsonb_typeof(document)='object'), input_digest char(64) NOT NULL CHECK(input_digest ~ '^[0-9a-f]{64}$'), quality text NOT NULL CHECK(quality IN ('INTERACTIVE','LUXURY','PHOTOREAL')), simulated boolean NOT NULL DEFAULT false, error_code text, summary jsonb, attempts int NOT NULL DEFAULT 0 CHECK(attempts>=0), lease_until timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), FOREIGN KEY(project_id,revision_id) REFERENCES revision(project_id,id), CHECK((kind = 'PREVIEW') = (operation IS NOT NULL)), CHECK(state <> 'FAILED' OR error_code IS NOT NULL), CHECK(state <> 'RUNNING' OR lease_until IS NOT NULL));
CREATE INDEX job_queue ON job(created_at,id) WHERE state IN ('QUEUED','RUNNING');
CREATE INDEX job_cache ON job(input_digest,kind) WHERE state = 'SUCCEEDED';
CREATE TABLE job_artifact(id uuid PRIMARY KEY, job_id uuid NOT NULL REFERENCES job, kind text NOT NULL CHECK(kind IN ('STEP','STL','GLB_PREVIEW','DFM_REPORT','MANIFEST','OPERATION_DIFF','MESH_REPORT')), units text NOT NULL CHECK(units IN ('mm','m','none')), name text NOT NULL CHECK(name ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'), sha256 char(64) NOT NULL CHECK(sha256 ~ '^[0-9a-f]{64}$'), bytes bigint NOT NULL CHECK(bytes>=0), UNIQUE(job_id,name));
CREATE TABLE sync_operation(id uuid PRIMARY KEY, actor text NOT NULL, device_id uuid NOT NULL, project_id uuid NOT NULL REFERENCES project, body_digest char(64) NOT NULL CHECK(body_digest ~ '^[0-9a-f]{64}$'), status text NOT NULL CHECK(status IN ('APPLIED','CONFLICT','REJECTED')), result jsonb NOT NULL CHECK(jsonb_typeof(result)='object'), created_at timestamptz NOT NULL DEFAULT now());
