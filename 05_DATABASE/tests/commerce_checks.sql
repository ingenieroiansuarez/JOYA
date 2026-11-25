-- Commercial slice (migration 0004, contracts 1.11.0). Run after state_checks.sql (reuses its rows).
-- Positive cases commit; each negative case must raise the expected error class.
SET search_path TO aurea;
BEGIN;
INSERT INTO location(id,name,kind) VALUES ('00000000-0000-0000-0000-0000000000b1','t','WORKSHOP');
INSERT INTO stock_lot(id,location_id,item_key,unit,on_hand,label) VALUES ('00000000-0000-0000-0000-0000000000b2','00000000-0000-0000-0000-0000000000b1','gold-18k-yellow','g',10,'lot');
INSERT INTO stock_movement(id,lot_id,quantity_delta,actor,reason,kind,on_hand_after) VALUES (gen_random_uuid(),'00000000-0000-0000-0000-0000000000b2',10,'t','alta','RECEIPT',10);
INSERT INTO payment(id,order_id,provider,provider_id,currency,amount,state,kind,simulated,created_by) VALUES ('00000000-0000-0000-0000-0000000000b3','00000000-0000-0000-0000-000000000005','simulated','sim_1','XXX',1,'PENDING','DEPOSIT',true,'sub');
INSERT INTO payment_event(provider,event_id,payment_id,event_type,payload_sha256,outcome) VALUES ('simulated','evt_1','00000000-0000-0000-0000-0000000000b3','payment.processing',repeat('a',64),'APPLIED');
COMMIT;
DO $$ BEGIN
  UPDATE quote SET amount = 2 WHERE id = '00000000-0000-0000-0000-000000000004';
  RAISE EXCEPTION 'negative case 1 (issued quote re-priced) was accepted';
EXCEPTION WHEN check_violation THEN NULL;
END $$;
DO $$ BEGIN
  DELETE FROM quote WHERE id = '00000000-0000-0000-0000-000000000004';
  RAISE EXCEPTION 'negative case 2 (quote deleted) was accepted';
EXCEPTION WHEN check_violation THEN NULL;
END $$;
DO $$ BEGIN
  INSERT INTO payment(id,order_id,provider,provider_id,currency,amount,state,kind,simulated,created_by) VALUES (gen_random_uuid(),'00000000-0000-0000-0000-000000000005','simulated','sim_2','XXX',1,'PENDING','DEPOSIT',true,'sub');
  RAISE EXCEPTION 'negative case 3 (second open deposit) was accepted';
EXCEPTION WHEN unique_violation THEN NULL;
END $$;
DO $$ BEGIN
  INSERT INTO payment_event(provider,event_id,payment_id,event_type,payload_sha256,outcome) VALUES ('simulated','evt_1',NULL,'payment.succeeded',repeat('b',64),'APPLIED');
  RAISE EXCEPTION 'negative case 4 (replayed provider event) was accepted';
EXCEPTION WHEN unique_violation THEN NULL;
END $$;
DO $$ BEGIN
  UPDATE payment_event SET outcome = 'IGNORED';
  RAISE EXCEPTION 'negative case 5 (provider event rewritten) was accepted';
EXCEPTION WHEN check_violation THEN NULL;
END $$;
DO $$ BEGIN
  UPDATE stock_lot SET reserved = 11 WHERE id = '00000000-0000-0000-0000-0000000000b2';
  RAISE EXCEPTION 'negative case 6 (oversold lot) was accepted';
EXCEPTION WHEN check_violation THEN NULL;
END $$;
DO $$ BEGIN
  UPDATE stock_movement SET quantity_delta = 99;
  RAISE EXCEPTION 'negative case 7 (ledger rewritten) was accepted';
EXCEPTION WHEN check_violation THEN NULL;
END $$;
DO $$ BEGIN
  UPDATE payment SET state = 'CONFIRMED' WHERE id = '00000000-0000-0000-0000-0000000000b3';
  RAISE EXCEPTION 'negative case 8 (confirmed without confirmed_at) was accepted';
EXCEPTION WHEN check_violation THEN NULL;
END $$;
DO $$ BEGIN
  UPDATE sales_order SET state = 'CANCELLED' WHERE id = '00000000-0000-0000-0000-000000000005';
  RAISE EXCEPTION 'negative case 9 (cancelled without reason) was accepted';
EXCEPTION WHEN check_violation THEN NULL;
END $$;
SELECT 'commerce checks OK';
