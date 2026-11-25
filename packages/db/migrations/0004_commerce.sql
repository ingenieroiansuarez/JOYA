-- Migration 0004: commercial slice (hito 500, contracts 1.11.0): quotes with frozen pricing snapshot,
-- orders, simulated deposits, stock reservations and append-only movements.
-- Must match 05_DATABASE/core_reference.sql (test/schema.test.mjs). Roll-forward only.
-- quote, sales_order, payment, payment_event, stock_lot, reservation and stock_movement existed empty
-- since 0000 (no API wrote them), so NOT NULL columns need no backfill.
SET search_path TO aurea,public;

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
