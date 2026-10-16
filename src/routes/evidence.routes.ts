import { Router, Request, Response, NextFunction } from 'express';
import path from 'path';
import fs from 'fs';
import { uploadEvidence } from '../middlewares/upload.middleware.js';
import { prisma } from '../config/prisma.js';
import { config } from '../config/env.js';
import { wsManager } from '../websocket/ws.manager.js';

const router = Router();

// On-demand video proof download: fetches directly from ThunderCompute when requested
router.get(
  '/download/:cameraId/:filename',
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { cameraId, filename } = req.params;
      const sanitizedFilename = path.basename(filename);
      const localFilePath = path.join(config.uploadDir, 'evidence', sanitizedFilename);

      // 1. If already cached locally, serve immediately
      if (fs.existsSync(localFilePath)) {
        res.download(localFilePath, sanitizedFilename);
        return;
      }

      // 2. Otherwise, fetch on-demand from ThunderCompute over WebSocket
      console.log(`📡 [On-Demand Evidence] Fetching '${sanitizedFilename}' from ThunderCompute (${cameraId})...`);
      const b64Data = await wsManager.requestClipFromInference(cameraId, sanitizedFilename);

      // Save cached copy locally
      const buffer = Buffer.from(b64Data, 'base64');
      fs.writeFileSync(localFilePath, buffer);

      // Stream download directly to client
      res.download(localFilePath, sanitizedFilename);
    } catch (err) {
      next(err);
    }
  }
);


router.post(
  '/upload',
  uploadEvidence.single('file'),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      if (!req.file) {
        res.status(400).json({ error: 'No file provided' });
        return;
      }

      const { cameraId, trackId, frameNumber, violationId } = req.body;
      const fileUrl = `/uploads/evidence/${req.file.filename}`;
      const isVideo = req.file.mimetype.includes('mp4') || req.file.originalname.endsWith('.mp4');

      console.log(`📥 [Evidence Upload] Received: ${req.file.filename} (${req.file.size} bytes)`);

      let updatedRecord = null;

      if (violationId) {
        updatedRecord = await prisma.violation.update({
          where: { id: violationId },
          data: isVideo ? { evidenceClipUrl: fileUrl } : { snapshotUrl: fileUrl },
        });
      } else if (cameraId && trackId && frameNumber) {
        const matching = await prisma.violation.findFirst({
          where: {
            cameraId,
            trackId: parseInt(trackId, 10),
            frameNumber: parseInt(frameNumber, 10),
          },
          orderBy: { createdAt: 'desc' },
        });

        if (matching) {
          updatedRecord = await prisma.violation.update({
            where: { id: matching.id },
            data: isVideo ? { evidenceClipUrl: fileUrl } : { snapshotUrl: fileUrl },
          });
        }
      }

      if (isVideo && updatedRecord) {
        wsManager.broadcastToClients({
          type: 'evidence_clip_update',
          violationId: updatedRecord.id,
          cameraId: updatedRecord.cameraId,
          trackId: updatedRecord.trackId,
          evidenceClipUrl: fileUrl,
        });
      }

      res.status(201).json({
        message: 'Evidence file uploaded successfully',
        fileUrl,
        filename: req.file.filename,
        linkedViolation: updatedRecord ? updatedRecord.id : null,
      });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
