-- =============================================================================
-- VDAT Database Initialization Script (PostgreSQL)
-- =============================================================================
-- Run this as the postgres superuser (e.g., psql -U postgres -f init_db.sql):

-- 1. Refresh collation version if needed by your OS
ALTER DATABASE template1 REFRESH COLLATION VERSION;
ALTER DATABASE postgres REFRESH COLLATION VERSION;

-- 2. Create the dedicated VDAT database
CREATE DATABASE vdat_db;

-- 3. Create the database user with credentials
DO $$
BEGIN
    IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'vdat_user') THEN
        CREATE ROLE vdat_user WITH LOGIN PASSWORD 'vdat_secret';
    END IF;
END
$$;

-- 4. Transfer ownership and grant schema privileges
ALTER DATABASE vdat_db OWNER TO vdat_user;

\c vdat_db

GRANT ALL ON SCHEMA public TO vdat_user;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO vdat_user;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO vdat_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO vdat_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO vdat_user;

-- Connection string for .env:
-- DATABASE_URL="postgresql://vdat_user:vdat_secret@localhost:5432/vdat_db?schema=public"
