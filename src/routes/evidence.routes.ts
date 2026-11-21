import { Router, Request, Response, NextFunction } from 'express';
import path from 'path';
import fs from 'fs';
import { uploadEvidence } from '../middlewares/upload.middleware.js';
import { prisma } from '../config/prisma.js';
import { config } from '../config/env.js';
import { wsManager, evidenceEvents } from '../websocket/ws.manager.js';

const router = Router();

// Temporary Ephemeral Cache Policy (prevents backend storage from flooding)
const EVIDENCE_CLIP_TTL_MS = parseInt(
  process.env.EVIDENCE_CLIP_TTL_MS || String(10 * 60 * 1000),
  10
);
const MAX_CACHED_CLIPS = parseInt(process.env.MAX_CACHED_CLIPS || '15', 10);
const MAX_CACHED_SNAPSHOTS = parseInt(process.env.MAX_CACHED_SNAPSHOTS || '100', 10);
const clipCleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();
let isCleaningCache = false;

/**
 * Marks a temporary MP4 clip with a 10-minute inactivity TTL and schedules async LRU cleanup.
 */
export function touchTemporaryEvidence(filePath: string): void {
  if (!filePath.endsWith('.mp4')) return;

  const existingTimer = clipCleanupTimers.get(filePath);
  if (existingTimer) {
    clearTimeout(existingTimer);
  }

  const now = new Date();
  void fs.promises.utimes(filePath, now, now).catch(() => {});

  const timer = setTimeout(() => {
    clipCleanupTimers.delete(filePath);
    void fs.promises
      .unlink(filePath)
      .then(() => {
        console.log(`[Evidence Cache] Auto-purged expired temporary clip: ${path.basename(filePath)}`);
      })
      .catch(() => {});
  }, EVIDENCE_CLIP_TTL_MS);

  if (typeof timer.unref === 'function') {
    timer.unref();
  }
  clipCleanupTimers.set(filePath, timer);

  setImmediate(() => {
    void enforceEvidenceCacheLimits();
  });
}

/**
 * Async status-aware cache eviction:
 * - Evicts temporary MP4 clips older than TTL or beyond MAX_CACHED_CLIPS
 * - Protects CONFIRMED violation JPG snapshots while pruning unconfirmed/old JPGs beyond MAX_CACHED_SNAPSHOTS
 */
export async function enforceEvidenceCacheLimits(): Promise<void> {
  if (isCleaningCache) return;
  isCleaningCache = true;
  const evidenceDir = path.join(config.uploadDir, 'evidence');

  try {
    const exists = fs.existsSync(evidenceDir);
    if (!exists) return;

    const names = await fs.promises.readdir(evidenceDir);
    const statResults = await Promise.all(
      names.map(async (name) => {
        const fullPath = path.join(evidenceDir, name);
        try {
          const stat = await fs.promises.stat(fullPath);
          return { name, fullPath, mtimeMs: stat.mtimeMs, isFile: stat.isFile() };
        } catch {
          return null;
        }
      })
    );

    const validEntries = statResults.filter(
      (e): e is { name: string; fullPath: string; mtimeMs: number; isFile: boolean } =>
        Boolean(e && e.isFile)
    );

    // 1. Evict oldest temporary MP4 clips beyond MAX_CACHED_CLIPS or older than TTL
    const nowMs = Date.now();
    const mp4Files = validEntries
      .filter((e) => e.name.endsWith('.mp4'))
      .sort((a, b) => a.mtimeMs - b.mtimeMs);

    for (let i = 0; i < mp4Files.length; i++) {
      const item = mp4Files[i];
      const isExpired = nowMs - item.mtimeMs > EVIDENCE_CLIP_TTL_MS;
      const isOverLimit = mp4Files.length - i > MAX_CACHED_CLIPS;
      if (isExpired || isOverLimit) {
        await fs.promises.unlink(item.fullPath).catch(() => {});
        const t = clipCleanupTimers.get(item.fullPath);
        if (t) {
          clearTimeout(t);
          clipCleanupTimers.delete(item.fullPath);
        }
        console.log(`[Evidence Cache] Evicted temporary video clip: ${item.name}`);
      }
    }

    // 2. Evict unconfirmed JPG snapshots beyond MAX_CACHED_SNAPSHOTS (never evict CONFIRMED snapshots)
    const jpgFiles = validEntries
      .filter((e) => e.name.endsWith('.jpg') || e.name.endsWith('.jpeg'))
      .sort((a, b) => a.mtimeMs - b.mtimeMs);

    if (jpgFiles.length > MAX_CACHED_SNAPSHOTS) {
      const confirmedRows = await prisma.violation
        .findMany({
          where: { status: 'CONFIRMED', snapshotUrl: { not: null } },
          select: { snapshotUrl: true },
        })
        .catch(() => []);
      const protectedSnapshots = new Set(
        confirmedRows.map((r) => path.basename(r.snapshotUrl || ''))
      );

      const evictableJpgs = jpgFiles.filter((j) => !protectedSnapshots.has(j.name));
      const excessCount = jpgFiles.length - MAX_CACHED_SNAPSHOTS;
      for (const item of evictableJpgs.slice(0, Math.max(0, excessCount))) {
        await fs.promises.unlink(item.fullPath).catch(() => {});
      }
    }
  } catch {
    // Ignore directory scan errors
  } finally {
    isCleaningCache = false;
  }
}

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

async function handleEvidenceStreamOrDownload(
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

router.get('/stream/:cameraId/:filename', handleEvidenceStreamOrDownload);
router.get('/download/:cameraId/:filename', handleEvidenceStreamOrDownload);

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
);

export default router;
