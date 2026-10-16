import { Router, Request, Response, NextFunction } from 'express';
import path from 'path';
import fs from 'fs';
import { Readable } from 'stream';
import { finished } from 'stream/promises';
import { uploadEvidence } from '../middlewares/upload.middleware.js';
import { prisma } from '../config/prisma.js';
import { config } from '../config/env.js';
import { wsManager } from '../websocket/ws.manager.js';

const router = Router();

// On-demand video proof download: fetches from ThunderCompute's HTTP evidence server
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

      // 2. Fetch on-demand from ThunderCompute's HTTP evidence server
      const evidenceUrl = `${config.thunderComputeUrl}/${sanitizedFilename}`;
      console.log(`📡 [On-Demand Evidence] Fetching '${sanitizedFilename}' via HTTP from ${evidenceUrl}`);

      const response = await fetch(evidenceUrl, { signal: AbortSignal.timeout(120000) });

      if (!response.ok) {
        if (response.status === 404) {
          res.status(404).json({
            error: 'Evidence clip not found',
            detail: `File '${sanitizedFilename}' does not exist on ThunderCompute.`,
          });
          return;
        }
        throw new Error(`ThunderCompute responded with HTTP ${response.status}`);
      }

      // Stream response body to local cache file
      fs.mkdirSync(path.dirname(localFilePath), { recursive: true });
      const fileStream = fs.createWriteStream(localFilePath);
      // @ts-ignore - Node 18+ fetch body is a ReadableStream
      await finished(Readable.fromWeb(response.body as any).pipe(fileStream));

      console.log(`✅ [On-Demand Evidence] Cached '${sanitizedFilename}' locally`);

      // Serve the cached file
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
