-- =============================================================================
-- VDAT Full Database Initialization & DDL Schema Script (PostgreSQL)
-- =============================================================================
-- Run as postgres superuser:
--   psql -U postgres -f init_db.sql
-- =============================================================================

-- -----------------------------------------------------------------------------
-- PART 1: Database & Role Creation
-- -----------------------------------------------------------------------------

-- Refresh collation versions if needed
ALTER DATABASE template1 REFRESH COLLATION VERSION;
ALTER DATABASE postgres REFRESH COLLATION VERSION;

-- Create dedicated database
CREATE DATABASE vdat_db;

-- Create application user
DO $$
BEGIN
    IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'vdat_user') THEN
        CREATE ROLE vdat_user WITH LOGIN PASSWORD 'vdat_secret';
    END IF;
END
$$;

-- Set database ownership
ALTER DATABASE vdat_db OWNER TO vdat_user;

-- Connect to the new database
\c vdat_db

-- Grant schema privileges
GRANT ALL ON SCHEMA public TO vdat_user;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO vdat_user;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO vdat_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO vdat_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO vdat_user;

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
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'POLICE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- 2. Cameras Table
CREATE TABLE "cameras" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "location" TEXT NOT NULL,
    "rtspUrl" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastSeenAt" TIMESTAMP(3),
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cameras_pkey" PRIMARY KEY ("id")
);

-- 3. Camera Configurations Table (Zone Polygons & Traffic Lights)
CREATE TABLE "camera_configs" (
    "id" TEXT NOT NULL,
    "cameraId" TEXT NOT NULL,
    "lanes" JSONB NOT NULL,
    "intersection" JSONB NOT NULL,
    "lightBox" JSONB,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "camera_configs_pkey" PRIMARY KEY ("id")
);

-- 4. Violations Table
CREATE TABLE "violations" (
    "id" TEXT NOT NULL,
    "cameraId" TEXT NOT NULL,
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
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "violations_pkey" PRIMARY KEY ("id")
);

-- -----------------------------------------------------------------------------
-- PART 4: Indexes
-- -----------------------------------------------------------------------------

CREATE UNIQUE INDEX "users_email_key" ON "users"("email");
CREATE UNIQUE INDEX "camera_configs_cameraId_key" ON "camera_configs"("cameraId");

CREATE INDEX "violations_cameraId_idx" ON "violations"("cameraId");
CREATE INDEX "violations_status_idx" ON "violations"("status");
CREATE INDEX "violations_createdAt_idx" ON "violations"("createdAt");

-- -----------------------------------------------------------------------------
-- PART 5: Foreign Key Constraints
-- -----------------------------------------------------------------------------

ALTER TABLE "camera_configs"
    ADD CONSTRAINT "camera_configs_cameraId_fkey"
    FOREIGN KEY ("cameraId") REFERENCES "cameras"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "violations"
    ADD CONSTRAINT "violations_cameraId_fkey"
    FOREIGN KEY ("cameraId") REFERENCES "cameras"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "violations"
    ADD CONSTRAINT "violations_reviewedById_fkey"
    FOREIGN KEY ("reviewedById") REFERENCES "users"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- Grant permissions on newly created tables to application user
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO vdat_user;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO vdat_user;

-- -----------------------------------------------------------------------------
-- Connection string for .env:
-- DATABASE_URL="postgresql://vdat_user:vdat_secret@localhost:5432/vdat_db?schema=public"
-- -----------------------------------------------------------------------------
