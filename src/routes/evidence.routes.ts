import { Router, Request, Response, NextFunction } from 'express';
import path from 'path';
import { uploadEvidence } from '../middlewares/upload.middleware.js';
import { prisma } from '../config/prisma.js';
import { wsManager } from '../websocket/ws.manager.js';

const router = Router();

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
