-- PostgreSQL reference DDL, demo vertical slice; review before applying.
CREATE SCHEMA IF NOT EXISTS aurea;
SET search_path TO aurea,public;
CREATE TABLE customer(id uuid PRIMARY KEY, subject text UNIQUE NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE location(id uuid PRIMARY KEY, name text NOT NULL, kind text NOT NULL CHECK(kind IN ('STORE','WORKSHOP','VAULT','WAREHOUSE')));
CREATE TABLE project(id uuid PRIMARY KEY, owner_id uuid NOT NULL REFERENCES customer, title text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), family_id text NOT NULL CHECK(family_id ~ '^[a-z]+\.[a-z0-9]+$'), updated_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX project_owner_recent ON project(owner_id,updated_at DESC,id);
CREATE TABLE revision(id uuid PRIMARY KEY, project_id uuid NOT NULL REFERENCES project, parent_id uuid, number int NOT NULL CHECK(number>0), document jsonb NOT NULL, digest char(64) NOT NULL, state text NOT NULL DEFAULT 'DRAFT' CHECK(state IN ('DRAFT','REVIEW','APPROVED','SUPERSEDED')), created_by text NOT NULL, source text NOT NULL CHECK(source IN ('CREATE','PREVIEW','SYNC','AI')), source_id uuid, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(project_id,number), UNIQUE(project_id,id), FOREIGN KEY(project_id,parent_id) REFERENCES revision(project_id,id), CONSTRAINT revision_digest_check CHECK(digest ~ '^[0-9a-f]{64}$'), CONSTRAINT revision_source_id_check CHECK((source = 'CREATE') = (source_id IS NULL)));
CREATE TABLE branch(project_id uuid NOT NULL REFERENCES project, name text NOT NULL CHECK(name ~ '^[a-z0-9][a-z0-9._-]{0,63}$'), head_id uuid NOT NULL, PRIMARY KEY(project_id,name), FOREIGN KEY(project_id,head_id) REFERENCES revision(project_id,id));
CREATE TABLE dfm_report(id uuid PRIMARY KEY, revision_id uuid NOT NULL REFERENCES revision, rules_version text NOT NULL, state text NOT NULL CHECK(state IN ('PASS','WARN','REVIEW','FAIL')), report jsonb NOT NULL, created_at timestamptz DEFAULT now());
CREATE TABLE quote(id uuid PRIMARY KEY, revision_id uuid NOT NULL REFERENCES revision, currency char(3) NOT NULL, amount numeric(20,6) NOT NULL CHECK(amount>=0), snapshot jsonb NOT NULL, digest char(64) NOT NULL CHECK(digest ~ '^[0-9a-f]{64}$'), expires_at timestamptz NOT NULL, state text NOT NULL CHECK(state IN ('DRAFT','ISSUED','ACCEPTED','EXPIRED','REJECTED','SUPERSEDED')), accepted_at timestamptz, CHECK(state <> 'ACCEPTED' OR accepted_at IS NOT NULL));
CREATE TABLE sales_order(id uuid PRIMARY KEY, quote_id uuid UNIQUE NOT NULL REFERENCES quote, state text NOT NULL DEFAULT 'PENDING_PAYMENT' CHECK(state IN ('PENDING_PAYMENT','CONFIRMED','FULFILLING','READY','DELIVERED','CANCELLED')), created_at timestamptz DEFAULT now());
CREATE TABLE payment(id uuid PRIMARY KEY, order_id uuid NOT NULL REFERENCES sales_order, provider text NOT NULL, provider_id text NOT NULL, currency char(3) NOT NULL, amount numeric(20,6) NOT NULL CHECK(amount>0), state text NOT NULL CHECK(state IN ('PENDING','PROCESSING','FAILED','CONFIRMED','PARTIAL_REFUND','REFUNDED','DISPUTED')), UNIQUE(provider,provider_id));
CREATE TABLE payment_event(provider text NOT NULL, event_id text NOT NULL, payment_id uuid REFERENCES payment, received_at timestamptz DEFAULT now(), PRIMARY KEY(provider,event_id));
CREATE TABLE stock_lot(id uuid PRIMARY KEY, location_id uuid NOT NULL REFERENCES location, item_key text NOT NULL, unit text NOT NULL CHECK(unit IN ('g','ct','ea')), on_hand numeric(20,6) NOT NULL CHECK(on_hand>=0), reserved numeric(20,6) NOT NULL DEFAULT 0 CHECK(reserved>=0 AND reserved<=on_hand));
CREATE TABLE reservation(id uuid PRIMARY KEY, lot_id uuid NOT NULL REFERENCES stock_lot, order_id uuid NOT NULL REFERENCES sales_order, quantity numeric(20,6) NOT NULL CHECK(quantity>0), expires_at timestamptz NOT NULL, state text NOT NULL CHECK(state IN ('HELD','ALLOCATED','RELEASED','CONSUMED')));
CREATE TABLE stock_movement(id uuid PRIMARY KEY, lot_id uuid NOT NULL REFERENCES stock_lot, quantity_delta numeric(20,6) NOT NULL CHECK(quantity_delta<>0), actor text NOT NULL, reason text NOT NULL, recorded_at timestamptz DEFAULT now());
CREATE TABLE work_order(id uuid PRIMARY KEY, order_id uuid NOT NULL REFERENCES sales_order, revision_id uuid NOT NULL REFERENCES revision, state text NOT NULL CHECK(state IN ('PLANNED','RELEASED','IN_PROGRESS','BLOCKED','QA','DONE','CANCELLED')), approved_by text, CHECK(state NOT IN ('RELEASED','IN_PROGRESS','QA','DONE') OR approved_by IS NOT NULL));
CREATE TABLE work_task(id uuid PRIMARY KEY, work_order_id uuid NOT NULL REFERENCES work_order, name text NOT NULL, state text NOT NULL, assigned_to text, planned_start timestamptz, planned_end timestamptz, CHECK(planned_end>=planned_start));
CREATE TABLE audit_event(id uuid PRIMARY KEY, actor text NOT NULL, action text NOT NULL, resource_id uuid NOT NULL, correlation_id uuid NOT NULL, recorded_at timestamptz NOT NULL DEFAULT now(), details jsonb NOT NULL DEFAULT '{}');
CREATE TABLE outbox(id uuid PRIMARY KEY, event_type text NOT NULL CHECK(event_type ~ '^[A-Z][A-Za-z0-9]{2,63}$'), schema_version int NOT NULL CHECK(schema_version>=1), aggregate_id uuid NOT NULL, aggregate_version int NOT NULL CHECK(aggregate_version>=1), occurred_at timestamptz NOT NULL, correlation_id uuid NOT NULL, causation_id uuid, payload jsonb NOT NULL CHECK(jsonb_typeof(payload)='object'), created_at timestamptz NOT NULL DEFAULT now(), published_at timestamptz, seq bigint GENERATED ALWAYS AS IDENTITY, tx xid8 NOT NULL DEFAULT pg_current_xact_id(), UNIQUE(aggregate_id,aggregate_version));
CREATE INDEX outbox_pull ON outbox(tx,seq);
CREATE INDEX outbox_pending ON outbox(created_at) WHERE published_at IS NULL;
CREATE TABLE inbox(consumer text NOT NULL,event_id uuid NOT NULL,processed_at timestamptz DEFAULT now(),PRIMARY KEY(consumer,event_id));
CREATE TABLE idempotency(actor text NOT NULL, scope text NOT NULL, key text NOT NULL, request_digest char(64) NOT NULL, response jsonb, created_at timestamptz DEFAULT now(),PRIMARY KEY(actor,scope,key));
CREATE TABLE product(id uuid PRIMARY KEY, sku text UNIQUE NOT NULL CHECK(sku ~ '^[A-Z0-9][A-Z0-9-]{2,31}$'), position int NOT NULL CHECK(position>=0), category text NOT NULL CHECK(category IN ('RING','PENDANT','EARRINGS','BRACELET','NECKLACE')), metal text NOT NULL CHECK(metal IN ('GOLD_18K_YELLOW','GOLD_18K_WHITE','GOLD_18K_ROSE','SILVER_925','PLATINUM_950')), metal_weight_g numeric(12,3) NOT NULL CHECK(metal_weight_g>0), stones jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(stones)='array'), content jsonb NOT NULL CHECK(jsonb_typeof(content)='object' AND content ? 'es'), currency char(3) NOT NULL CHECK(currency ~ '^[A-Z]{3}$'), price numeric(20,6) NOT NULL CHECK(price>=0), available boolean NOT NULL, customizable boolean NOT NULL, published_at timestamptz, created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX product_published ON product(position,id) WHERE published_at IS NOT NULL;
CREATE TABLE favorite(customer_id uuid NOT NULL REFERENCES customer, product_id uuid NOT NULL REFERENCES product, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(customer_id,product_id));
CREATE INDEX favorite_recent ON favorite(customer_id,created_at DESC,product_id);
-- Hito 300 (migration 0002): revisions immutable except state; jobs, artifacts, sync operations.
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
CREATE TABLE job(id uuid PRIMARY KEY, kind text NOT NULL CHECK(kind IN ('PREVIEW','GEOMETRY','VALIDATION','AI')), state text NOT NULL DEFAULT 'QUEUED' CHECK(state IN ('QUEUED','RUNNING','SUCCEEDED','FAILED','CANCELLED')), actor text NOT NULL, project_id uuid NOT NULL REFERENCES project, revision_id uuid NOT NULL, operation jsonb, document jsonb NOT NULL CHECK(jsonb_typeof(document)='object'), input_digest char(64) NOT NULL CHECK(input_digest ~ '^[0-9a-f]{64}$'), quality text NOT NULL CHECK(quality IN ('INTERACTIVE','LUXURY','PHOTOREAL')), simulated boolean NOT NULL DEFAULT false, error_code text, summary jsonb, attempts int NOT NULL DEFAULT 0 CHECK(attempts>=0), lease_until timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), FOREIGN KEY(project_id,revision_id) REFERENCES revision(project_id,id), CHECK((kind = 'PREVIEW') = (operation IS NOT NULL)), CHECK(state <> 'FAILED' OR error_code IS NOT NULL), CHECK(state <> 'RUNNING' OR lease_until IS NOT NULL));
CREATE INDEX job_queue ON job(created_at,id) WHERE state IN ('QUEUED','RUNNING');
CREATE INDEX job_cache ON job(input_digest,kind) WHERE state = 'SUCCEEDED';
CREATE TABLE job_artifact(id uuid PRIMARY KEY, job_id uuid NOT NULL REFERENCES job, kind text NOT NULL CHECK(kind IN ('STEP','STL','GLB_PREVIEW','DFM_REPORT','MANIFEST','OPERATION_DIFF','MESH_REPORT')), units text NOT NULL CHECK(units IN ('mm','m','none')), name text NOT NULL CHECK(name ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'), sha256 char(64) NOT NULL CHECK(sha256 ~ '^[0-9a-f]{64}$'), bytes bigint NOT NULL CHECK(bytes>=0), UNIQUE(job_id,name));
CREATE TABLE sync_operation(id uuid PRIMARY KEY, actor text NOT NULL, device_id uuid NOT NULL, project_id uuid NOT NULL REFERENCES project, body_digest char(64) NOT NULL CHECK(body_digest ~ '^[0-9a-f]{64}$'), status text NOT NULL CHECK(status IN ('APPLIED','CONFLICT','REJECTED')), result jsonb NOT NULL CHECK(jsonb_typeof(result)='object'), created_at timestamptz NOT NULL DEFAULT now());
-- AURA (hito 400): proposals keep only the prompt hash; quota ledger append-only.
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
-- Commercial slice (hito 500, migration 0004): frozen quotes, orders, simulated deposits, stock ledger.
-- Quote: a DRAFT is priced by the server from a fixed revision; issuing freezes it (terms, expiry, digest).
ALTER TABLE quote ADD COLUMN project_id uuid NOT NULL REFERENCES project;
ALTER TABLE quote ADD CONSTRAINT quote_project_revision_fkey FOREIGN KEY(project_id,revision_id) REFERENCES revision(project_id,id);
ALTER TABLE quote ADD COLUMN customer_id uuid NOT NULL REFERENCES customer;
ALTER TABLE quote ADD COLUMN requested_by text NOT NULL;
ALTER TABLE quote ADD COLUMN draft_digest char(64) NOT NULL CHECK(draft_digest ~ '^[0-9a-f]{64}$');
ALTER TABLE quote ADD COLUMN deposit_amount numeric(20,6) NOT NULL CHECK(deposit_amount>=0);
ALTER TABLE quote ADD CONSTRAINT quote_deposit_le_amount CHECK(deposit_amount<=amount);
ALTER TABLE quote ADD COLUMN terms_version text;
ALTER TABLE quote ADD COLUMN issued_by text;
ALTER TABLE quote ADD COLUMN issued_at timestamptz;
ALTER TABLE quote ADD COLUMN decision_reason text CHECK(char_length(decision_reason) BETWEEN 1 AND 2000);
ALTER TABLE quote ADD COLUMN version int NOT NULL DEFAULT 1 CHECK(version>=1);
ALTER TABLE quote ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE quote ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE quote ALTER COLUMN state SET DEFAULT 'DRAFT';
ALTER TABLE quote ADD CONSTRAINT quote_issued_fields CHECK(state = 'DRAFT' OR (issued_by IS NOT NULL AND issued_at IS NOT NULL AND terms_version IS NOT NULL));
CREATE INDEX quote_project ON quote(project_id,created_at DESC);
CREATE INDEX quote_state ON quote(state,created_at DESC);
-- At most one open quote per revision: asking again returns the open one.
CREATE UNIQUE INDEX quote_open_revision ON quote(revision_id) WHERE state IN ('DRAFT','ISSUED');
-- Once issued, the commercial terms are frozen: only the state, the decision and the bookkeeping move.
CREATE FUNCTION quote_frozen() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'quote % cannot be deleted', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW.id, NEW.revision_id, NEW.project_id, NEW.customer_id, NEW.requested_by, NEW.created_at)
     IS DISTINCT FROM (OLD.id, OLD.revision_id, OLD.project_id, OLD.customer_id, OLD.requested_by, OLD.created_at) THEN
    RAISE EXCEPTION 'quote % identity is immutable', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.state <> 'DRAFT' AND (NEW.currency, NEW.amount, NEW.snapshot, NEW.digest, NEW.draft_digest, NEW.deposit_amount, NEW.expires_at,
       NEW.terms_version, NEW.issued_by, NEW.issued_at)
     IS DISTINCT FROM (OLD.currency, OLD.amount, OLD.snapshot, OLD.digest, OLD.draft_digest, OLD.deposit_amount, OLD.expires_at,
       OLD.terms_version, OLD.issued_by, OLD.issued_at) THEN
    RAISE EXCEPTION 'quote % is frozen once issued', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.state IN ('ACCEPTED','REJECTED','EXPIRED','SUPERSEDED') AND NEW.state IS DISTINCT FROM OLD.state THEN
    RAISE EXCEPTION 'quote % is final (%)', OLD.id, OLD.state USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER quote_frozen BEFORE UPDATE OR DELETE ON quote FOR EACH ROW EXECUTE FUNCTION quote_frozen();

-- Order: created atomically by acceptQuote; amounts copied from the frozen quote.
ALTER TABLE sales_order ADD COLUMN customer_id uuid NOT NULL REFERENCES customer;
ALTER TABLE sales_order ADD COLUMN currency char(3) NOT NULL CHECK(currency ~ '^[A-Z]{3}$');
ALTER TABLE sales_order ADD COLUMN total numeric(20,6) NOT NULL CHECK(total>=0);
ALTER TABLE sales_order ADD COLUMN deposit_required numeric(20,6) NOT NULL CHECK(deposit_required>=0);
ALTER TABLE sales_order ADD CONSTRAINT sales_order_deposit_le_total CHECK(deposit_required<=total);
ALTER TABLE sales_order ADD COLUMN created_by text NOT NULL;
ALTER TABLE sales_order ADD COLUMN cancel_reason text CHECK(char_length(cancel_reason) BETWEEN 1 AND 2000);
ALTER TABLE sales_order ADD CONSTRAINT sales_order_cancel_reason CHECK(state <> 'CANCELLED' OR cancel_reason IS NOT NULL);
ALTER TABLE sales_order ADD COLUMN version int NOT NULL DEFAULT 1 CHECK(version>=1);
ALTER TABLE sales_order ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE sales_order ALTER COLUMN created_at SET NOT NULL;
CREATE INDEX sales_order_customer ON sales_order(customer_id,created_at DESC);
CREATE INDEX sales_order_state ON sales_order(state,created_at DESC);

-- Payment: one open or confirmed deposit per order at most (duplicate-payment backstop).
ALTER TABLE payment ADD COLUMN kind text NOT NULL CHECK(kind IN ('DEPOSIT','BALANCE'));
ALTER TABLE payment ADD COLUMN simulated boolean NOT NULL;
ALTER TABLE payment ADD COLUMN created_by text NOT NULL;
ALTER TABLE payment ADD COLUMN confirmed_at timestamptz;
ALTER TABLE payment ADD CONSTRAINT payment_confirmed_at CHECK(state NOT IN ('CONFIRMED','PARTIAL_REFUND','REFUNDED','DISPUTED') OR confirmed_at IS NOT NULL);
ALTER TABLE payment ADD COLUMN failure_code text CHECK(failure_code ~ '^[A-Z][A-Z0-9_]{1,63}$');
ALTER TABLE payment ADD COLUMN review_reason text CHECK(review_reason IN ('AMOUNT_MISMATCH','ORDER_CANCELLED','STOCK_UNAVAILABLE','LATE_EVENT'));
ALTER TABLE payment ADD COLUMN version int NOT NULL DEFAULT 1 CHECK(version>=1);
ALTER TABLE payment ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE payment ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE payment ADD CONSTRAINT payment_currency_check CHECK(currency ~ '^[A-Z]{3}$');
CREATE UNIQUE INDEX payment_one_deposit ON payment(order_id) WHERE kind = 'DEPOSIT' AND state IN ('PENDING','PROCESSING','CONFIRMED','PARTIAL_REFUND','DISPUTED');
CREATE INDEX payment_order ON payment(order_id,created_at);

-- Provider events, append-only and deduplicated by (provider, event_id): a replay changes nothing.
ALTER TABLE payment_event ADD COLUMN event_type text NOT NULL CHECK(event_type ~ '^[a-z]+\.[a-z_]+$');
ALTER TABLE payment_event ADD COLUMN payload_sha256 char(64) NOT NULL CHECK(payload_sha256 ~ '^[0-9a-f]{64}$');
ALTER TABLE payment_event ADD COLUMN outcome text NOT NULL CHECK(outcome IN ('APPLIED','IGNORED','REVIEW'));
ALTER TABLE payment_event ALTER COLUMN received_at SET NOT NULL;
CREATE FUNCTION payment_event_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'payment_event is append-only' USING ERRCODE = 'check_violation';
END $$;
CREATE TRIGGER payment_event_append_only BEFORE UPDATE OR DELETE ON payment_event FOR EACH ROW EXECUTE FUNCTION payment_event_append_only();

-- Stock: on_hand and reserved are projections kept in the same transaction as the ledger
-- (stock_movement) and the reservations; reserved<=on_hand (0000) makes overselling impossible.
ALTER TABLE stock_lot ADD COLUMN label text NOT NULL CHECK(char_length(label) BETWEEN 1 AND 120);
ALTER TABLE stock_lot ADD COLUMN demo boolean NOT NULL DEFAULT false;
ALTER TABLE stock_lot ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX stock_lot_item ON stock_lot(item_key,created_at,id);
ALTER TABLE reservation ADD COLUMN created_by text NOT NULL;
ALTER TABLE reservation ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE reservation ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX reservation_lot_open ON reservation(lot_id,expires_at) WHERE state IN ('HELD','ALLOCATED');
CREATE INDEX reservation_order ON reservation(order_id);
ALTER TABLE stock_movement ADD COLUMN kind text NOT NULL CHECK(kind IN ('RECEIPT','ADJUSTMENT','ISSUE'));
ALTER TABLE stock_movement ADD COLUMN on_hand_after numeric(20,6) NOT NULL CHECK(on_hand_after>=0);
ALTER TABLE stock_movement ADD CONSTRAINT stock_movement_reason_check CHECK(char_length(reason) BETWEEN 1 AND 500);
ALTER TABLE stock_movement ALTER COLUMN recorded_at SET NOT NULL;
CREATE INDEX stock_movement_lot ON stock_movement(lot_id,recorded_at);
CREATE FUNCTION stock_movement_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'stock_movement is append-only' USING ERRCODE = 'check_violation';
END $$;
CREATE TRIGGER stock_movement_append_only BEFORE UPDATE OR DELETE ON stock_movement FOR EACH ROW EXECUTE FUNCTION stock_movement_append_only();
-- Application-level transaction rules and grants are mandatory. Protect append-only tables and immutable revisions with restricted DB roles/triggers in production.
