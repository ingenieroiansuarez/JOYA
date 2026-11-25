-- AURA tables (migration 0003, contracts 1.10.0). Run after design_checks.sql.
-- Positive cases commit; each negative case must raise the expected error class.
SET search_path TO aurea;
BEGIN;
INSERT INTO ai_proposal(id,actor,project_id,base_revision_id,provider,model,simulated,prompt_sha256,prompt_chars,locale,result,expires_at)
VALUES ('00000000-0000-0000-0000-0000000000a1','sub','00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000003','aura-sim','aura-rules-0.1.0',true,repeat('a',64),12,'es','{"options":[]}',now()+interval '30 minutes');
INSERT INTO ai_usage(id,actor,day,entry,units,request_id,provider) VALUES (gen_random_uuid(),'sub',current_date,'RESERVE',1,'00000000-0000-0000-0000-0000000000a1','aura-sim');
COMMIT;
DO $$ BEGIN
  UPDATE ai_proposal SET state='ACCEPTED' WHERE id='00000000-0000-0000-0000-0000000000a1';
  RAISE EXCEPTION 'negative case 1 (accepted proposal without revision) was accepted';
EXCEPTION WHEN check_violation THEN NULL;
END $$;
DO $$ BEGIN
  UPDATE ai_proposal SET state='PREVIEWING' WHERE id='00000000-0000-0000-0000-0000000000a1';
  RAISE EXCEPTION 'negative case 2 (previewing without job) was accepted';
EXCEPTION WHEN check_violation THEN NULL;
END $$;
DO $$ BEGIN
  UPDATE ai_proposal SET state='APPLIED' WHERE id='00000000-0000-0000-0000-0000000000a1';
  RAISE EXCEPTION 'negative case 3 (unknown state) was accepted';
EXCEPTION WHEN check_violation THEN NULL;
END $$;
DO $$ BEGIN
  UPDATE ai_usage SET units=0 WHERE actor='sub';
  RAISE EXCEPTION 'negative case 4 (ledger updated) was accepted';
EXCEPTION WHEN check_violation THEN NULL;
END $$;
DO $$ BEGIN
  DELETE FROM ai_usage WHERE actor='sub';
  RAISE EXCEPTION 'negative case 5 (ledger row deleted) was accepted';
EXCEPTION WHEN check_violation THEN NULL;
END $$;
DO $$ BEGIN
  INSERT INTO ai_usage(id,actor,day,entry,units,request_id,provider) VALUES (gen_random_uuid(),'sub',current_date,'RESERVE',1,'00000000-0000-0000-0000-0000000000a1','aura-sim');
  RAISE EXCEPTION 'negative case 6 (second reserve for the same request) was accepted';
EXCEPTION WHEN unique_violation THEN NULL;
END $$;
DO $$ BEGIN
  INSERT INTO ai_proposal(id,actor,project_id,base_revision_id,provider,model,simulated,prompt_sha256,prompt_chars,locale,result,expires_at)
  VALUES (gen_random_uuid(),'sub','00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000003','x','y',true,repeat('a',64),2001,'es','{}',now());
  RAISE EXCEPTION 'negative case 7 (prompt longer than 2000) was accepted';
EXCEPTION WHEN check_violation THEN NULL;
END $$;
SELECT 'ai checks OK';
