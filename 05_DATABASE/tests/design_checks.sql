-- Design tables (migration 0002, contracts 1.9.0). Run after core_reference.sql and state_checks.sql.
-- Positive cases commit; each negative case must raise the expected error class.
SET search_path TO aurea;
BEGIN;
INSERT INTO job(id,kind,actor,project_id,revision_id,operation,document,input_digest,quality)
VALUES ('00000000-0000-0000-0000-0000000000b1','PREVIEW','sub','00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000003','{"type":"modify_parameter"}','{}',repeat('b',64),'INTERACTIVE');
UPDATE revision SET state='REVIEW' WHERE id='00000000-0000-0000-0000-000000000003';
COMMIT;
DO $$ BEGIN
  UPDATE revision SET document='{"x":1}' WHERE id='00000000-0000-0000-0000-000000000003';
  RAISE EXCEPTION 'negative case 1 (revision document changed) was accepted';
EXCEPTION WHEN check_violation THEN NULL;
END $$;
DO $$ BEGIN
  UPDATE revision SET digest=repeat('c',64) WHERE id='00000000-0000-0000-0000-000000000003';
  RAISE EXCEPTION 'negative case 2 (revision digest changed) was accepted';
EXCEPTION WHEN check_violation THEN NULL;
END $$;
DO $$ BEGIN
  DELETE FROM revision WHERE id='00000000-0000-0000-0000-000000000003';
  RAISE EXCEPTION 'negative case 3 (revision deleted) was accepted';
EXCEPTION WHEN check_violation THEN NULL;
END $$;
DO $$ BEGIN
  INSERT INTO revision(id,project_id,number,document,digest,created_by,source) VALUES (gen_random_uuid(),'00000000-0000-0000-0000-000000000002',2,'{}',repeat('a',64),'sub','SYNC');
  RAISE EXCEPTION 'negative case 4 (SYNC revision without source_id) was accepted';
EXCEPTION WHEN check_violation THEN NULL;
END $$;
DO $$ BEGIN
  INSERT INTO revision(id,project_id,number,document,digest,created_by,source) VALUES (gen_random_uuid(),'00000000-0000-0000-0000-000000000002',2,'{}','NOT-HEX','sub','CREATE');
  RAISE EXCEPTION 'negative case 5 (digest not hex) was accepted';
EXCEPTION WHEN check_violation THEN NULL;
END $$;
DO $$ BEGIN
  UPDATE job SET state='FAILED' WHERE id='00000000-0000-0000-0000-0000000000b1';
  RAISE EXCEPTION 'negative case 6 (FAILED job without error code) was accepted';
EXCEPTION WHEN check_violation THEN NULL;
END $$;
DO $$ BEGIN
  UPDATE job SET state='RUNNING' WHERE id='00000000-0000-0000-0000-0000000000b1';
  RAISE EXCEPTION 'negative case 7 (RUNNING job without lease) was accepted';
EXCEPTION WHEN check_violation THEN NULL;
END $$;
DO $$ BEGIN
  INSERT INTO job(id,kind,actor,project_id,revision_id,document,input_digest,quality)
  VALUES (gen_random_uuid(),'PREVIEW','sub','00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000003','{}',repeat('b',64),'INTERACTIVE');
  RAISE EXCEPTION 'negative case 8 (PREVIEW job without operation) was accepted';
EXCEPTION WHEN check_violation THEN NULL;
END $$;
DO $$ BEGIN
  INSERT INTO job_artifact(id,job_id,kind,units,name,sha256,bytes) VALUES (gen_random_uuid(),'00000000-0000-0000-0000-0000000000b1','STEP','mm','../../etc/passwd',repeat('a',64),1);
  RAISE EXCEPTION 'negative case 9 (artifact name with a path) was accepted';
EXCEPTION WHEN check_violation THEN NULL;
END $$;
SELECT 'design checks OK';
