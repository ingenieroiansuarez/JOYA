-- Outbox follows 07_DOMAIN_MODELS/event.schema.json (contracts 1.4.0).
-- Run after core_reference.sql: psql -v ON_ERROR_STOP=1 -f 05_DATABASE/tests/outbox_checks.sql
-- Positive cases commit; each negative case must raise the expected error class.
SET search_path TO aurea;
BEGIN;
INSERT INTO outbox(id,event_type,schema_version,aggregate_id,aggregate_version,occurred_at,correlation_id,causation_id,payload)
VALUES ('00000000-0000-0000-0000-0000000000e1','QuoteAccepted',1,'00000000-0000-0000-0000-0000000000a1',1,now(),'00000000-0000-0000-0000-0000000000c1',null,'{}'),
       ('00000000-0000-0000-0000-0000000000e2','OrderCreated',1,'00000000-0000-0000-0000-0000000000a1',2,now(),'00000000-0000-0000-0000-0000000000c1','00000000-0000-0000-0000-0000000000e1','{"orderId":"x"}');
COMMIT;
DO $$ BEGIN
  INSERT INTO outbox(id,event_type,schema_version,aggregate_id,aggregate_version,occurred_at,correlation_id,payload)
  VALUES (gen_random_uuid(),'QuoteRejected',1,'00000000-0000-0000-0000-0000000000a1',2,now(),gen_random_uuid(),'{}');
  RAISE EXCEPTION 'negative case 1 (same aggregate version twice) was accepted';
EXCEPTION WHEN unique_violation THEN NULL;
END $$;
DO $$ BEGIN
  INSERT INTO outbox(id,event_type,schema_version,aggregate_id,aggregate_version,occurred_at,correlation_id,payload)
  VALUES (gen_random_uuid(),'quote.accepted',1,gen_random_uuid(),1,now(),gen_random_uuid(),'{}');
  RAISE EXCEPTION 'negative case 2 (event type not PascalCase) was accepted';
EXCEPTION WHEN check_violation THEN NULL;
END $$;
DO $$ BEGIN
  INSERT INTO outbox(id,event_type,schema_version,aggregate_id,aggregate_version,occurred_at,correlation_id,payload)
  VALUES (gen_random_uuid(),'QuoteAccepted',1,gen_random_uuid(),1,now(),gen_random_uuid(),'[]');
  RAISE EXCEPTION 'negative case 3 (payload not an object) was accepted';
EXCEPTION WHEN check_violation THEN NULL;
END $$;
DO $$ BEGIN
  INSERT INTO outbox(id,event_type,schema_version,aggregate_id,aggregate_version,payload)
  VALUES (gen_random_uuid(),'QuoteAccepted',1,gen_random_uuid(),1,'{}');
  RAISE EXCEPTION 'negative case 4 (no occurred_at / correlation_id) was accepted';
EXCEPTION WHEN not_null_violation THEN NULL;
END $$;
DO $$ BEGIN
  INSERT INTO outbox(id,event_type,schema_version,aggregate_id,aggregate_version,occurred_at,correlation_id,payload)
  VALUES (gen_random_uuid(),'QuoteAccepted',0,gen_random_uuid(),1,now(),gen_random_uuid(),'{}');
  RAISE EXCEPTION 'negative case 5 (schema_version 0) was accepted';
EXCEPTION WHEN check_violation THEN NULL;
END $$;
SELECT 'outbox checks OK';
