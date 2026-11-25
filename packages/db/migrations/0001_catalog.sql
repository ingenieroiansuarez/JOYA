-- Migration 0001: boutique catalog and favorites (hito 200, contracts 1.8.0).
-- Must match 05_DATABASE/core_reference.sql (test/schema.test.mjs). Roll-forward only.
SET search_path TO aurea,public;
CREATE TABLE product(id uuid PRIMARY KEY, sku text UNIQUE NOT NULL CHECK(sku ~ '^[A-Z0-9][A-Z0-9-]{2,31}$'), position int NOT NULL CHECK(position>=0), category text NOT NULL CHECK(category IN ('RING','PENDANT','EARRINGS','BRACELET','NECKLACE')), metal text NOT NULL CHECK(metal IN ('GOLD_18K_YELLOW','GOLD_18K_WHITE','GOLD_18K_ROSE','SILVER_925','PLATINUM_950')), metal_weight_g numeric(12,3) NOT NULL CHECK(metal_weight_g>0), stones jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(stones)='array'), content jsonb NOT NULL CHECK(jsonb_typeof(content)='object' AND content ? 'es'), currency char(3) NOT NULL CHECK(currency ~ '^[A-Z]{3}$'), price numeric(20,6) NOT NULL CHECK(price>=0), available boolean NOT NULL, customizable boolean NOT NULL, published_at timestamptz, created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX product_published ON product(position,id) WHERE published_at IS NOT NULL;
CREATE TABLE favorite(customer_id uuid NOT NULL REFERENCES customer, product_id uuid NOT NULL REFERENCES product, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(customer_id,product_id));
CREATE INDEX favorite_recent ON favorite(customer_id,created_at DESC,product_id);
