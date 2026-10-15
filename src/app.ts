import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import path from 'path';
import { config } from './config/env.js';
import { errorHandler } from './middlewares/error.middleware.js';

import authRoutes from './routes/auth.routes.js';
import cameraRoutes from './routes/camera.routes.js';
import violationRoutes from './routes/violation.routes.js';
import evidenceRoutes from './routes/evidence.routes.js';
import statsRoutes from './routes/stats.routes.js';

export function createApp(): express.Application {
  const app = express();

  // Security & HTTP Headers
  app.use(
    helmet({
      crossOriginResourcePolicy: { policy: 'cross-origin' }, // Allow frontend to fetch images/videos
    })
  );

  // CORS for local dev and Vercel production domains
  app.use(
    cors({
      origin: (origin, callback) => {
        // Allow requests with no origin (like mobile apps, curl, ThunderCompute)
        if (!origin) return callback(null, true);
        if (
          config.allowedOrigins.includes(origin) ||
          origin.endsWith('.vercel.app') ||
          config.nodeEnv === 'development'
        ) {
          return callback(null, true);
        }
        return callback(new Error(`Origin ${origin} not allowed by CORS`));
      },
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization'],
    })
  );

  app.use(morgan(config.nodeEnv === 'development' ? 'dev' : 'combined'));
  app.use(express.json({ limit: '50mb' }));
  app.use(express.urlencoded({ extended: true, limit: '50mb' }));

  // Serve static evidence snapshots and video clips
  app.use('/uploads', express.static(config.uploadDir));

  // Health check endpoint
  app.get('/health', (_req, res) => {
    res.json({
      status: 'UP',
      service: 'api.VDAT',
      timestamp: new Date().toISOString(),
    });
  });

  // REST API Routes
  app.use('/api/auth', authRoutes);
  app.use('/api/cameras', cameraRoutes);
  app.use('/api/violations', violationRoutes);
  app.use('/api/evidence', evidenceRoutes);
  app.use('/api/stats', statsRoutes);

  // Global Error Handler
  app.use(errorHandler);

  return app;
}
