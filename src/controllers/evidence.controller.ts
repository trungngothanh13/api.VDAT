import { Request, Response, NextFunction } from 'express';
import fs from 'fs';
import path from 'path';
import { prisma } from '../config/prisma.js';
import { config } from '../config/env.js';
import { wsManager } from '../websocket/ws.manager.js';
import {
  enforceEvidenceCacheLimits,
  evidenceEvents,
  touchTemporaryEvidence,
} from '../services/evidence-cache.service.js';

/**
 * Streams an MP4 file using HTTP 206 Partial Content (Byte-Range requests)
 * or triggers attachment download when `?download=1` is passed.
 */
function streamOrDownloadVideo(req: Request, res: Response, filePath: string, filename: string): void {
  if (filePath.includes(path.join('uploads', 'evidence'))) {
    touchTemporaryEvidence(filePath);
  }

  const forceDownload = req.query.download === '1' || req.query.download === 'true';
  if (forceDownload) {
    res.download(filePath, filename);
    return;
  }

  const stat = fs.statSync(filePath);
  const fileSize = stat.size;
  const range = req.headers.range;

  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Content-Disposition', `inline; filename="${filename}"`);

  if (range) {
    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;

    if (isNaN(start) || isNaN(end) || start >= fileSize || end >= fileSize) {
      res.status(416).setHeader('Content-Range', `bytes */${fileSize}`).end();
      return;
    }

    const chunkSize = end - start + 1;
    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${fileSize}`);
    res.setHeader('Content-Length', chunkSize);
    fs.createReadStream(filePath, { start, end }).pipe(res);
  } else {
    res.status(200);
    res.setHeader('Content-Length', fileSize);
    fs.createReadStream(filePath).pipe(res);
  }
}

export async function streamEvidenceClip(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { cameraId, filename } = req.params;
    const sanitizedFilename = path.basename(filename);
    const localFilePath = path.join(config.uploadDir, 'evidence', sanitizedFilename);

    // 1. If already cached locally, stream immediately via HTTP Range
    if (fs.existsSync(localFilePath)) {
      streamOrDownloadVideo(req, res, localFilePath, sanitizedFilename);
      return;
    }

    console.log(
      `[Evidence Stream] Clip '${sanitizedFilename}' not yet cached locally. Requesting from AI Engine (${cameraId})...`
    );

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
          }, 15000);

          const onUploadDone = (savedPath: string) => {
            clearTimeout(timeoutTimer);
            resolve(savedPath);
          };

          evidenceEvents.once(sanitizedFilename, onUploadDone);
        });

        if (fs.existsSync(uploadedFilePath)) {
          streamOrDownloadVideo(req, res, uploadedFilePath, sanitizedFilename);
          return;
        }
      } catch (waitErr: any) {
        console.warn(`[Evidence Stream] WebSocket upload wait: ${waitErr.message}`);
      }
    }

    res.status(404).json({
      error: 'Evidence clip not found',
      detail: `File '${sanitizedFilename}' could not be retrieved from AI engine for camera '${cameraId}'.`,
    });
  } catch (err) {
    next(err);
  }
}

export async function uploadEvidenceFile(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    if (!req.file) {
      res.status(400).json({ error: 'No file provided' });
      return;
    }

    const { cameraId, trackId, frameNumber, violationId } = req.body;
    const isVideo = req.file.mimetype.includes('mp4') || req.file.originalname.endsWith('.mp4');

    // AI Engine (EvidenceRecorder) already encodes H.264 (+faststart); zero backend ffmpeg needed
    if (isVideo) {
      touchTemporaryEvidence(req.file.path);
    } else {
      setImmediate(() => {
        void enforceEvidenceCacheLimits();
      });
    }

    const effectiveCameraId = cameraId || 'cam-01';
    const fileUrl = isVideo
      ? `/api/evidence/stream/${effectiveCameraId}/${req.file.filename}`
      : `/uploads/evidence/${req.file.filename}`;

    console.log(`[Evidence Upload] Received: ${req.file.filename} (${req.file.size} bytes)`);

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
        frameNumber: updatedRecord.frameNumber,
        evidenceClipUrl: fileUrl,
      });
    }

    res.status(201).json({
      message: 'Evidence file uploaded and ready for streaming',
      fileUrl,
      filename: req.file.filename,
      linkedViolation: updatedRecord ? updatedRecord.id : null,
    });
  } catch (err) {
    next(err);
  }
}
