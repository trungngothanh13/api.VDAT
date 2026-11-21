-- =============================================================================
-- VDAT Full Database Reset & Schema Script (PostgreSQL)
-- =============================================================================
-- Drops all existing VDAT tables/enums and recreates the ZoneProfile-based
-- schema from scratch.
--
-- Usage on existing vdat_db:
--   psql -U vdat_user -d vdat_db -f init_db.sql
--
-- First-time database/role creation (as postgres superuser, if needed):
--   CREATE ROLE vdat_user WITH LOGIN PASSWORD 'vdat_secret';
--   CREATE DATABASE vdat_db OWNER vdat_user;
-- =============================================================================

-- -----------------------------------------------------------------------------
-- PART 1: Drop Every Existing Table & Enum Type
-- -----------------------------------------------------------------------------

DROP TABLE IF EXISTS "violations" CASCADE;
DROP TABLE IF EXISTS "camera_configs" CASCADE;
DROP TABLE IF EXISTS "cameras" CASCADE;
DROP TABLE IF EXISTS "zone_profiles" CASCADE;
DROP TABLE IF EXISTS "users" CASCADE;

DROP TYPE IF EXISTS "ViolationStatus" CASCADE;
DROP TYPE IF EXISTS "Role" CASCADE;

-- -----------------------------------------------------------------------------
-- PART 2: Custom Enum Types
-- -----------------------------------------------------------------------------

CREATE TYPE "Role" AS ENUM ('POLICE', 'ADMIN');
CREATE TYPE "ViolationStatus" AS ENUM ('PENDING_REVIEW', 'CONFIRMED', 'DISMISSED');

-- -----------------------------------------------------------------------------
-- PART 3: Table Definitions (DDL)
-- -----------------------------------------------------------------------------

-- 1. Users Table
CREATE TABLE "users" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'POLICE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- 2. Zone Profiles Table (Keyed by Video / Camera Source: sourceKey)
CREATE TABLE "zone_profiles" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "sourceKey" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "lanes" JSONB NOT NULL,
    "intersection" JSONB NOT NULL,
    "exitZones" JSONB NOT NULL DEFAULT '[]'::jsonb,
    "lightBox" JSONB,
    "crossingMode" BOOLEAN NOT NULL DEFAULT false,
    "clearanceSeconds" DOUBLE PRECISION NOT NULL DEFAULT 3.0,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "zone_profiles_pkey" PRIMARY KEY ("id")
);

-- 3. Cameras Table (6+ Monitoring Channels)
CREATE TABLE "cameras" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "location" TEXT NOT NULL,
    "rtspUrl" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "lastSeenAt" TIMESTAMP(3),
    "activeSourceKey" TEXT,
    "activeZoneProfileId" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cameras_pkey" PRIMARY KEY ("id")
);

-- 4. Violations Table
CREATE TABLE "violations" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "cameraId" TEXT NOT NULL,
    "zoneProfileId" TEXT,
    "sourceKey" TEXT,
    "trackId" INTEGER NOT NULL,
    "vehicleClass" TEXT NOT NULL,
    "classId" INTEGER NOT NULL,
    "frameNumber" INTEGER NOT NULL,
    "timestamp" TEXT NOT NULL,
    "lightState" TEXT NOT NULL,
    "bbox" JSONB NOT NULL,
    "confidence" DOUBLE PRECISION,
    "snapshotUrl" TEXT,
    "evidenceClipUrl" TEXT,
    "status" "ViolationStatus" NOT NULL DEFAULT 'PENDING_REVIEW',
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "violations_pkey" PRIMARY KEY ("id")
);

-- -----------------------------------------------------------------------------
-- PART 4: Indexes
-- -----------------------------------------------------------------------------

CREATE UNIQUE INDEX "users_email_key" ON "users"("email");
CREATE UNIQUE INDEX "zone_profiles_sourceKey_key" ON "zone_profiles"("sourceKey");

CREATE INDEX "violations_cameraId_idx" ON "violations"("cameraId");
CREATE INDEX "violations_status_idx" ON "violations"("status");
CREATE INDEX "violations_createdAt_idx" ON "violations"("createdAt");

-- -----------------------------------------------------------------------------
-- PART 5: Foreign Key Constraints
-- -----------------------------------------------------------------------------

ALTER TABLE "cameras"
    ADD CONSTRAINT "cameras_activeZoneProfileId_fkey"
    FOREIGN KEY ("activeZoneProfileId") REFERENCES "zone_profiles"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "violations"
    ADD CONSTRAINT "violations_cameraId_fkey"
    FOREIGN KEY ("cameraId") REFERENCES "cameras"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "violations"
    ADD CONSTRAINT "violations_zoneProfileId_fkey"
    FOREIGN KEY ("zoneProfileId") REFERENCES "zone_profiles"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "violations"
    ADD CONSTRAINT "violations_reviewedById_fkey"
    FOREIGN KEY ("reviewedById") REFERENCES "users"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- -----------------------------------------------------------------------------
-- PART 6: Ownership & Permissions (Safe when run as postgres or vdat_user)
-- -----------------------------------------------------------------------------

DO $$
BEGIN
    IF EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'vdat_user') THEN
        ALTER TYPE "Role" OWNER TO vdat_user;
        ALTER TYPE "ViolationStatus" OWNER TO vdat_user;
        ALTER TABLE "users" OWNER TO vdat_user;
        ALTER TABLE "zone_profiles" OWNER TO vdat_user;
        ALTER TABLE "cameras" OWNER TO vdat_user;
        ALTER TABLE "violations" OWNER TO vdat_user;
        GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO vdat_user;
        GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO vdat_user;
    END IF;
END
$$;

-- -----------------------------------------------------------------------------
-- PART 7: Default Users & Camera Slots (Self-Contained 1-Run Seed)
-- -----------------------------------------------------------------------------

-- Default accounts: admin@vdat.local / admin123, officer@vdat.local / police123
INSERT INTO "users" ("id", "email", "passwordHash", "fullName", "role") VALUES
    ('00000000-0000-4000-8000-000000000001', 'admin@vdat.local', '$2a$10$bjCMHfcVW9ukTBi4J/5AJOYNeIN2a9IRouUQINoPYzjASC3Fj1SAG', 'System Administrator', 'ADMIN'),
    ('00000000-0000-4000-8000-000000000002', 'officer@vdat.local', '$2a$10$BJ5bCr4K59nuu43C/4HIoufBQOAtIR4sro5FvygtrmpJr4NDtKMX.', 'Traffic Officer', 'POLICE')
ON CONFLICT ("email") DO NOTHING;

INSERT INTO "cameras" ("id", "name", "location", "isActive") VALUES
    ('cam-01', 'Camera 01 (Primary)', 'Intersection 1', false),
    ('cam-02', 'Camera 02', 'Intersection 2', false),
    ('cam-03', 'Camera 03', 'Intersection 3', false),
    ('cam-04', 'Camera 04', 'Intersection 4', false),
    ('cam-05', 'Camera 05', 'Intersection 5', false),
    ('cam-06', 'Camera 06', 'Intersection 6', false)
ON CONFLICT ("id") DO NOTHING;

-- -----------------------------------------------------------------------------
-- Connection string for .env:
-- DATABASE_URL="postgresql://vdat_user:vdat_secret@localhost:5432/vdat_db?schema=public"
-- This script is self-contained: running it drops/rebuilds all tables and
-- seeds the default admin/officer users and 6 camera slots in 1 run.
-- -----------------------------------------------------------------------------
