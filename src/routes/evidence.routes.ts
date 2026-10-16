import { Router, Request, Response, NextFunction } from 'express';
import path from 'path';
import fs from 'fs';
import { Readable } from 'stream';
import { finished } from 'stream/promises';
import { uploadEvidence } from '../middlewares/upload.middleware.js';
import { prisma } from '../config/prisma.js';
import { config } from '../config/env.js';
import { wsManager, evidenceEvents } from '../websocket/ws.manager.js';

const router = Router();

// On-demand video proof download: triggers AI engine to upload over WebSocket, or serves from local cache
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

      console.log(`📡 [On-Demand Evidence] Proof clip '${sanitizedFilename}' requested. Triggering upload from AI Engine...`);

      // 2. Request AI engine to upload this specific clip via WebSocket
      const requested = wsManager.sendToInference(cameraId, {
        type: 'request_clip_upload',
        cameraId,
        filename: sanitizedFilename,
      });

      if (requested) {
        try {
          const uploadedFilePath = await new Promise<string>((resolve, reject) => {
            const timeoutTimer = setTimeout(() => {
              evidenceEvents.off(sanitizedFilename, onUploadDone);
              reject(new Error(`Timeout waiting for AI Engine to upload '${sanitizedFilename}'`));
            }, 45000);

            const onUploadDone = (savedPath: string) => {
              clearTimeout(timeoutTimer);
              resolve(savedPath);
            };

            evidenceEvents.once(sanitizedFilename, onUploadDone);
          });

          if (fs.existsSync(uploadedFilePath)) {
            console.log(`✅ [On-Demand Evidence] Delivered '${sanitizedFilename}' to client`);
            res.download(uploadedFilePath, sanitizedFilename);
            return;
          }
        } catch (waitErr: any) {
          console.warn(`⚠️ [On-Demand Evidence] WebSocket upload wait: ${waitErr.message}`);
        }
      } else {
        console.warn(`⚠️ [On-Demand Evidence] AI Engine is not connected for camera '${cameraId}'.`);
      }

      // 3. Fallback: If thunderComputeUrl is explicitly configured (not default localhost:8080), try HTTP fetch
      if (config.thunderComputeUrl && !config.thunderComputeUrl.includes('localhost:8080')) {
        try {
          const evidenceUrl = `${config.thunderComputeUrl}/${sanitizedFilename}`;
          console.log(`📡 [On-Demand Evidence] Trying legacy HTTP fallback from ${evidenceUrl}`);

          const response = await fetch(evidenceUrl, { signal: AbortSignal.timeout(15000) });
          if (response.ok && response.body) {
            fs.mkdirSync(path.dirname(localFilePath), { recursive: true });
            const fileStream = fs.createWriteStream(localFilePath);
            // @ts-ignore
            await finished(Readable.fromWeb(response.body as any).pipe(fileStream));
            res.download(localFilePath, sanitizedFilename);
            return;
          }
        } catch {
          // Fall through to 404
        }
      }

      res.status(404).json({
        error: 'Evidence clip not found',
        detail: `File '${sanitizedFilename}' could not be retrieved from AI engine (engine offline or file not on disk).`,
      });
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

      // Notify any pending on-demand download requests waiting for this file
      evidenceEvents.emit(req.file.filename, req.file.path);
      evidenceEvents.emit(req.file.originalname, req.file.path);
      evidenceEvents.emit(path.basename(req.file.originalname), req.file.path);

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
