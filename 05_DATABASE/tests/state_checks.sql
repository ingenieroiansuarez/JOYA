-- State CHECK constraints follow 08_STATE_MACHINES/machines.json (contracts 1.1.0; quote.digest 1.3.0).
-- Run after core_reference.sql: psql -v ON_ERROR_STOP=1 -f 05_DATABASE/tests/state_checks.sql
-- Positive cases commit; each negative case must raise check_violation (23514).
SET search_path TO aurea;
BEGIN;
INSERT INTO customer VALUES ('00000000-0000-0000-0000-000000000001','sub');
INSERT INTO project(id,owner_id,title,family_id) VALUES ('00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000001','t','ring.classic');
INSERT INTO revision(id,project_id,number,document,digest,created_by,source) VALUES ('00000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000002',1,'{}',repeat('a',64),'sub','CREATE');
SELECT 'revision default', state FROM revision;
INSERT INTO dfm_report(id,revision_id,rules_version,state,report) VALUES (gen_random_uuid(),'00000000-0000-0000-0000-000000000003','v','REVIEW','{}');
INSERT INTO quote(id,revision_id,project_id,customer_id,requested_by,draft_digest,deposit_amount,terms_version,issued_by,issued_at,currency,amount,snapshot,digest,expires_at,state) VALUES ('00000000-0000-0000-0000-000000000004','00000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000001','sub',repeat('a',64),0,'t','adv',now(),'XXX',1,'{}',repeat('a',64),now(),'ISSUED');
INSERT INTO sales_order(id,quote_id,customer_id,currency,total,deposit_required,created_by) VALUES ('00000000-0000-0000-0000-000000000005','00000000-0000-0000-0000-000000000004','00000000-0000-0000-0000-000000000001','XXX',1,0,'sub');
SELECT 'order default', state FROM sales_order;
INSERT INTO payment(id,order_id,provider,provider_id,currency,amount,state,kind,simulated,created_by,confirmed_at) VALUES (gen_random_uuid(),'00000000-0000-0000-0000-000000000005','sim','p1','XXX',1,'PARTIAL_REFUND','BALANCE',true,'sub',now());
COMMIT;
DO $$ BEGIN
  INSERT INTO payment(id,order_id,provider,provider_id,currency,amount,state,kind,simulated,created_by,confirmed_at) VALUES (gen_random_uuid(),'00000000-0000-0000-0000-000000000005','sim','p2','XXX',1,'PAID','BALANCE',true,'sub',now());
  RAISE EXCEPTION 'negative case 1 was accepted';
EXCEPTION WHEN check_violation THEN NULL;
END $$;
DO $$ BEGIN
  UPDATE revision SET state='PUBLISHED';
  RAISE EXCEPTION 'negative case 2 was accepted';
EXCEPTION WHEN check_violation THEN NULL;
END $$;
DO $$ BEGIN
  UPDATE sales_order SET state='SHIPPED';
  RAISE EXCEPTION 'negative case 3 was accepted';
EXCEPTION WHEN check_violation THEN NULL;
END $$;
DO $$ BEGIN
  INSERT INTO dfm_report(id,revision_id,rules_version,state,report) VALUES (gen_random_uuid(),'00000000-0000-0000-0000-000000000003','v','OK','{}');
  RAISE EXCEPTION 'negative case 4 was accepted';
EXCEPTION WHEN check_violation THEN NULL;
END $$;
DO $$ BEGIN
  INSERT INTO quote(id,revision_id,project_id,customer_id,requested_by,draft_digest,deposit_amount,terms_version,issued_by,issued_at,currency,amount,snapshot,digest,expires_at,state) VALUES (gen_random_uuid(),'00000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000001','sub',repeat('a',64),0,'t','adv',now(),'XXX',1,'{}',repeat('G',64),now(),'ISSUED');
  RAISE EXCEPTION 'negative case 5 was accepted';
EXCEPTION WHEN check_violation THEN NULL;
END $$;
SET search_path TO aurea;
SELECT 'state checks OK';
