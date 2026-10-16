import dotenv from 'dotenv';
import path from 'path';

dotenv.config();

export const config = {
  port: parseInt(process.env.PORT || '5000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  databaseUrl: process.env.DATABASE_URL || 'postgresql://vdat_user:vdat_secret@localhost:5432/vdat_db?schema=public',
  jwtSecret: process.env.JWT_SECRET || 'vdat_super_secret_jwt_key_2026_change_in_production',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '7d',
  allowedOrigins: (process.env.ALLOWED_ORIGINS || 'http://localhost:5173,http://localhost:3000')
    .split(',')
    .map((o) => o.trim()),
  uploadDir: path.resolve(process.env.UPLOAD_DIR || './uploads'),
  maxFileSizeMb: parseInt(process.env.MAX_FILE_SIZE_MB || '100', 10),
  // ThunderCompute evidence server URL (HTTP endpoint serving video clips)
  thunderComputeUrl: process.env.THUNDER_COMPUTE_URL || 'http://localhost:8080',
};
