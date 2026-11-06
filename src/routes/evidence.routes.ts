import { Router, Request, Response, NextFunction } from 'express';
import path from 'path';
import fs from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { uploadEvidence } from '../middlewares/upload.middleware.js';
import { prisma } from '../config/prisma.js';
import { config } from '../config/env.js';
import { wsManager, evidenceEvents } from '../websocket/ws.manager.js';

const execFileAsync = promisify(execFile);
const router = Router();

// Temporary Ephemeral Cache Policy (prevents backend storage from flooding)
const EVIDENCE_CLIP_TTL_MS = parseInt(process.env.EVIDENCE_CLIP_TTL_MS || String(10 * 60 * 1000), 10); // 10 minutes
const MAX_CACHED_CLIPS = parseInt(process.env.MAX_CACHED_CLIPS || '15', 10);
const MAX_CACHED_SNAPSHOTS = parseInt(process.env.MAX_CACHED_SNAPSHOTS || '100', 10);
const clipCleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Marks a video evidence file as temporary: refreshes its inactivity TTL timer
 * and enforces strict LRU cache bounds on `uploads/evidence` so the backend server disk never floods.
 */
export function touchTemporaryEvidence(filePath: string): void {
  if (!filePath.endsWith('.mp4')) return;

  const existingTimer = clipCleanupTimers.get(filePath);
  if (existingTimer) {
    clearTimeout(existingTimer);
  }

  try {
    const now = new Date();
    if (fs.existsSync(filePath)) {
      fs.utimesSync(filePath, now, now);
    }
  } catch {
    // Ignore utimes errors
  }

  const timer = setTimeout(() => {
    clipCleanupTimers.delete(filePath);
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        console.log(`[Evidence Cache] Auto-purged expired temporary clip: ${path.basename(filePath)}`);
      }
    } catch {
      // Ignore unlink errors
    }
  }, EVIDENCE_CLIP_TTL_MS);

  if (typeof timer.unref === 'function') {
    timer.unref();
  }
  clipCleanupTimers.set(filePath, timer);

  enforceEvidenceCacheLimits();
}

export function enforceEvidenceCacheLimits(): void {
  const evidenceDir = path.join(config.uploadDir, 'evidence');
  if (!fs.existsSync(evidenceDir)) return;

  try {
    const entries = fs.readdirSync(evidenceDir).map((name) => {
      const fullPath = path.join(evidenceDir, name);
      try {
        const stat = fs.statSync(fullPath);
        return { name, fullPath, mtimeMs: stat.mtimeMs, isFile: stat.isFile() };
      } catch {
        return null;
      }
    });

    const validEntries = entries.filter(
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
        try {
          fs.unlinkSync(item.fullPath);
          const t = clipCleanupTimers.get(item.fullPath);
          if (t) {
            clearTimeout(t);
            clipCleanupTimers.delete(item.fullPath);
          }
          console.log(`[Evidence Cache] Evicted temporary video clip: ${item.name}`);
        } catch {
          // Ignore
        }
      }
    }

    // 2. Evict oldest JPG snapshots beyond MAX_CACHED_SNAPSHOTS
    const jpgFiles = validEntries
      .filter((e) => e.name.endsWith('.jpg') || e.name.endsWith('.jpeg'))
      .sort((a, b) => a.mtimeMs - b.mtimeMs);

    if (jpgFiles.length > MAX_CACHED_SNAPSHOTS) {
      const toRemove = jpgFiles.slice(0, jpgFiles.length - MAX_CACHED_SNAPSHOTS);
      for (const item of toRemove) {
        try {
          fs.unlinkSync(item.fullPath);
        } catch {
          // Ignore
        }
      }
    }
  } catch {
    // Ignore directory scan errors
  }
}

/**
 * Ensures an uploaded MP4 file uses H.264 (yuv420p + faststart) so HTML5 <video>
 * elements can stream and seek it natively in all modern browsers.
 */
async function ensureBrowserStreamableMp4(filePath: string): Promise<void> {
  if (!filePath.endsWith('.mp4') || !fs.existsSync(filePath)) return;

  try {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=codec_name',
      '-of',
      'default=noprint_wrappers=1:nokey=1',
      filePath,
    ]);
    const codec = stdout.trim().toLowerCase();
    if (codec === 'h264') {
      return;
    }

    const tmpOut = `${filePath}.h264.mp4`;
    await execFileAsync('ffmpeg', [
      '-y',
      '-loglevel',
      'error',
      '-i',
      filePath,
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-crf',
      '23',
      '-pix_fmt',
      'yuv420p',
      '-movflags',
      '+faststart',
      tmpOut,
    ]);

    if (fs.existsSync(tmpOut)) {
      fs.renameSync(tmpOut, filePath);
    }
  } catch {
    // If ffprobe/ffmpeg is unavailable or fails, keep original file
  }
}

/**
 * Streams an MP4 file using HTTP 206 Partial Content (Byte-Range requests)
 * for instant inline HTML5 <video> playback and scrubbing, or triggers attachment download
 * when `?download=1` is passed.
 */
function streamOrDownloadVideo(req: Request, res: Response, filePath: string, filename: string): void {
  // Refresh temporary TTL whenever a video clip in uploads/evidence is accessed
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
      `[Evidence Stream] Clip '${sanitizedFilename}' not yet cached locally. Requesting from AI Engine...`
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

    // 3. Fallback: If historical violation clip from local source video is requested while AI engine is offline,
    // extract the 6-second H.264 clip around the violation frame on-the-fly and cache it in uploads/evidence
    const frameMatch = sanitizedFilename.match(/_f(\d+)\.mp4$/i);
    const fallbackSourceVideo = path.resolve(
      process.cwd(),
      '../VehicleDetectionAndTrackingModule/test_1.mp4'
    );

    if (frameMatch && fs.existsSync(fallbackSourceVideo)) {
      const frameNum = parseInt(frameMatch[1], 10);
      const sourceTotalFrames = 10852;
      const effectiveFrame = frameNum % sourceTotalFrames;
      const centerSec = effectiveFrame / 30.0;
      const startSec = Math.max(0, centerSec - 3.0);

      try {
        await execFileAsync('ffmpeg', [
          '-y',
          '-loglevel',
          'error',
          '-ss',
          startSec.toFixed(2),
          '-i',
          fallbackSourceVideo,
          '-t',
          '6.0',
          '-c:v',
          'libx264',
          '-preset',
          'ultrafast',
          '-crf',
          '23',
          '-pix_fmt',
          'yuv420p',
          '-movflags',
          '+faststart',
          '-an',
          localFilePath,
        ]);

        if (fs.existsSync(localFilePath)) {
          streamOrDownloadVideo(req, res, localFilePath, sanitizedFilename);
          return;
        }
      } catch (extractErr: any) {
        console.warn(`[Evidence Stream] Local clip extraction fallback failed: ${extractErr.message}`);
      }
    }

    res.status(404).json({
      error: 'Evidence clip not found',
      detail: `File '${sanitizedFilename}' could not be retrieved from AI engine.`,
    });
  } catch (err) {
    next(err);
  }
}

router.get('/sample-video', (req: Request, res: Response, next: NextFunction): void => {
  try {
    const requestedFile = typeof req.query.file === 'string' ? path.basename(req.query.file) : 'test_1.mp4';
    const allowedFiles = new Set(['test_1.mp4', 'test_2.mp4', 'test_3.mp4']);
    const targetFile = allowedFiles.has(requestedFile) ? requestedFile : 'test_1.mp4';
    const sampleVideoPath = path.resolve(
      process.cwd(),
      `../VehicleDetectionAndTrackingModule/${targetFile}`
    );
    if (!fs.existsSync(sampleVideoPath)) {
      res.status(404).json({ error: `Sample video file (${targetFile}) not found on server` });
      return;
    }
    streamOrDownloadVideo(req, res, sampleVideoPath, targetFile);
  } catch (err) {
    next(err);
  }
});

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

      if (isVideo) {
        await ensureBrowserStreamableMp4(req.file.path);
        touchTemporaryEvidence(req.file.path);
      } else {
        enforceEvidenceCacheLimits();
      }

      const effectiveCameraId = cameraId || 'cam-01';
      const fileUrl = isVideo
        ? `/api/evidence/stream/${effectiveCameraId}/${req.file.filename}`
        : `/uploads/evidence/${req.file.filename}`;

      console.log(`[Evidence Upload] Received: ${req.file.filename} (${req.file.size} bytes)`);

      // Notify any pending on-demand stream/download requests waiting for this file
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
