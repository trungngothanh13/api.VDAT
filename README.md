# api.VDAT — Backend Service & Stream Hub

Central backend API and WebSocket stream relay for the **VDAT** (Vehicle Detection and Tracking) Smart Surveillance System.

Built with **Node.js, Express, TypeScript, Prisma ORM, PostgreSQL, and WebSockets**.

---

## 🏗️ System Architecture

```
[ThunderCompute: AI Engine]
             │
             │ ws://<host>:5000/ws/inference (Outbound stream)
             ▼
      [api.VDAT Backend] ─── (PostgreSQL: Violations, Cameras, Users)
             │
             │ ws://<host>:5000/ws/client (Relayed stream)
             ▼
    [web.VDAT Dashboard]
```

---

## 🚀 Quick Start (Local Development)

### 1. Database Setup (PostgreSQL)

You can run the included [init_db.sql](init_db.sql) script with `psql`:

```bash
# Connect as postgres superuser and run initialization script:
psql -U postgres -f init_db.sql
```

The script executes the following exact SQL queries:
```sql
-- 1. Refresh collation version if needed
ALTER DATABASE template1 REFRESH COLLATION VERSION;
ALTER DATABASE postgres REFRESH COLLATION VERSION;

-- 2. Create database
CREATE DATABASE vdat_db;

-- 3. Create user
CREATE ROLE vdat_user WITH LOGIN PASSWORD 'vdat_secret';

-- 4. Set ownership and grant privileges
ALTER DATABASE vdat_db OWNER TO vdat_user;

\c vdat_db
GRANT ALL ON SCHEMA public TO vdat_user;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO vdat_user;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO vdat_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO vdat_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO vdat_user;
```

### 2. Environment Configuration

Check `.env` (already configured for local development):
```env
PORT=5000
NODE_ENV=development
DATABASE_URL="postgresql://vdat_user:vdat_secret@localhost:5432/vdat_db?schema=public"
JWT_SECRET="vdat_super_secret_jwt_key_2026_change_in_production"
JWT_EXPIRES_IN="7d"
ALLOWED_ORIGINS="http://localhost:5173,http://localhost:3000"
UPLOAD_DIR="./uploads"
MAX_FILE_SIZE_MB=100
```

### 3. Install & Seed

```bash
npm install
npx prisma db push
npx tsx prisma/seed.ts
```

#### Seeded Default Accounts:
* **Admin**: `admin@vdat.local` / `admin123` (Full access, zone configuration, user management)
* **Traffic Officer**: `officer@vdat.local` / `police123` (Monitoring & violation reviews)

### 4. Run Server

```bash
# Development (with hot-reload):
npm run dev

# Production build:
npm run build
npm start
```

---

## 📡 WebSocket Endpoints

| Endpoint | Purpose | Direction |
| :--- | :--- | :--- |
| `ws://localhost:5000/ws/inference` | Connected by AI Engine (ThunderCompute) | Inbound AI stream (`camera_init`, `frame`, `violation`, `evidence_clip_ready`) |
| `ws://localhost:5000/ws/client` | Connected by React Web Dashboard | Outbound broadcast stream (`live_frame`, `violation_alert`, `evidence_clip_update`) |

---

## 🔗 REST API Endpoints

All protected endpoints require `Authorization: Bearer <token>`.

### Authentication
* `POST /api/auth/login` — Sign in and receive JWT token.
* `GET /api/auth/me` — Get current logged-in user profile.

### Cameras
* `GET /api/cameras` — List all registered cameras with live status and violation count.
* `GET /api/cameras/:id` — Get single camera details and zone configuration.
* `PUT /api/cameras/:id/zones` — *(Admin only)* Update lane/intersection polygons and push update to AI engine.

### Violations
* `GET /api/violations` — Paginated violation log (filters: `cameraId`, `status`, `vehicleClass`, date range).
* `GET /api/violations/:id` — Get single violation details with evidence links.
* `PATCH /api/violations/:id/status` — Review violation (`CONFIRMED` or `DISMISSED`) with officer notes.

### Evidence
* `POST /api/evidence/upload` — Multipart upload for MP4 video clips and snapshots from ThunderCompute.
* `GET /uploads/evidence/:filename` — Public static file streaming for video playback.

### Analytics
* `GET /api/stats/overview` — Dashboard summary metrics and aggregations by vehicle class and camera.

---

## ☁️ Deployment to Render

1. Create a **Web Service** on [Render.com](https://render.com) connected to this repository.
2. Build command: `npm install && npx prisma generate && npm run build`
3. Start command: `npm start`
4. Create a **Render PostgreSQL** database and paste its connection URL into `DATABASE_URL`.
5. Render will assign an SSL domain (e.g. `https://api-vdat.onrender.com`).
   * AI Engine on ThunderCompute will connect to: `wss://api-vdat.onrender.com/ws/inference`
   * Web Dashboard will connect to: `https://api-vdat.onrender.com`
