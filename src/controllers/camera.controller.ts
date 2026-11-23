import { Request, Response, NextFunction } from 'express';
import fs from 'fs';
import path from 'path';
import { z } from 'zod';
import { prisma } from '../config/prisma.js';
import { config } from '../config/env.js';
import { wsManager } from '../websocket/ws.manager.js';

const stagedVideosByCamera = new Map<string, string>();

export function cleanupStagedVideoForCamera(cameraId: string): void {
  const existingPath = stagedVideosByCamera.get(cameraId);
  if (!existingPath) return;
  stagedVideosByCamera.delete(cameraId);
  void fs.promises.unlink(existingPath).catch(() => {});
}

export async function listCameras(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const cameras = await prisma.camera.findMany({
      include: {
        activeZoneProfile: true,
        _count: {
          select: { violations: true },
        },
      },
      orderBy: { id: 'asc' },
    });

    const activeCameras = new Set(wsManager.getActiveCameras());

    const result = cameras.map((cam) => {
      const { activeZoneProfile, _count, ...rest } = cam;
      return {
        ...rest,
        config: activeZoneProfile,
        isLive: activeCameras.has(cam.id),
        violationCount: _count.violations,
      };
    });

    res.json(result);
  } catch (err) {
    next(err);
  }
}

export async function listZoneProfiles(
  _req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const profiles = await prisma.zoneProfile.findMany({
      orderBy: { updatedAt: 'desc' },
    });
    res.json(profiles);
  } catch (err) {
    next(err);
  }
}

export async function getCamera(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { id } = req.params;
    const camera = await prisma.camera.findUnique({
      where: { id },
      include: { activeZoneProfile: true },
    });

    if (!camera) {
      res.status(404).json({ error: 'Camera not found' });
      return;
    }

    const activeCameras = new Set(wsManager.getActiveCameras());
    const { activeZoneProfile, ...rest } = camera;
    res.json({
      ...rest,
      config: activeZoneProfile,
      isLive: activeCameras.has(camera.id),
    });
  } catch (err) {
    next(err);
  }
}

const createCameraSchema = z.object({
  id: z
    .string()
    .trim()
    .min(2)
    .max(32)
    .regex(/^[a-zA-Z0-9_-]+$/, 'Camera ID may only contain letters, numbers, dashes, and underscores'),
  name: z.string().trim().min(1).max(80),
  location: z.string().trim().min(1).max(120).optional().default('Intersection'),
});

export async function createCamera(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const data = createCameraSchema.parse(req.body);
    const existing = await prisma.camera.findUnique({ where: { id: data.id } });
    if (existing) {
      res.status(409).json({ error: `Camera '${data.id}' already exists` });
      return;
    }

    const camera = await prisma.camera.create({
      data: {
        id: data.id,
        name: data.name,
        location: data.location,
        isActive: false,
        activeZoneProfileId: null,
      },
      include: { activeZoneProfile: true },
    });

    const { activeZoneProfile, ...rest } = camera;
    res.status(201).json({
      ...rest,
      config: activeZoneProfile,
    });
  } catch (err) {
    next(err);
  }
}

const deleteCamerasSchema = z.object({
  ids: z.array(z.string().trim().min(1)).min(1, 'Select at least one camera to delete'),
});

export async function deleteCamera(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { id } = req.params;
    const existing = await prisma.camera.findUnique({ where: { id }, select: { id: true } });
    if (!existing) {
      res.status(404).json({ error: `Camera '${id}' not found` });
      return;
    }

    await prisma.camera.delete({ where: { id } });
    cleanupStagedVideoForCamera(id);
    wsManager.sendToInference(id, { type: 'stop_source', cameraId: id });
    wsManager.cleanupCamera(id);
    console.log(`🗑️ [Camera] Deleted camera slot '${id}'`);
    res.json({ deleted: [id], count: 1 });
  } catch (err) {
    next(err);
  }
}

export async function deleteCameras(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { ids } = deleteCamerasSchema.parse(req.body);
    const uniqueIds = Array.from(new Set(ids));

    const existing = await prisma.camera.findMany({
      where: { id: { in: uniqueIds } },
      select: { id: true },
    });
    const existingIds = existing.map((cam) => cam.id);

    if (existingIds.length === 0) {
      res.status(404).json({ error: 'None of the selected cameras were found' });
      return;
    }

    const result = await prisma.camera.deleteMany({
      where: { id: { in: existingIds } },
    });

    for (const id of existingIds) {
      cleanupStagedVideoForCamera(id);
      wsManager.sendToInference(id, { type: 'stop_source', cameraId: id });
      wsManager.cleanupCamera(id);
    }

    console.log(`🗑️ [Camera] Deleted ${result.count} camera slot(s): ${existingIds.join(', ')}`);
    res.json({ deleted: existingIds, count: result.count });
  } catch (err) {
    next(err);
  }
}

export async function uploadCameraVideoSource(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { id } = req.params;
    const file = req.file;
    if (!file) {
      res.status(400).json({ error: 'No video file provided' });
      return;
    }

    if (!wsManager.hasActiveInference(id)) {
      await fs.promises.unlink(file.path).catch(() => {});
      res.status(503).json({
        code: 'AI_OFFLINE',
        error: `AI Engine is offline for camera '${id}'. Connect ai.VDAT before uploading a video.`,
      });
      return;
    }

    cleanupStagedVideoForCamera(id);
    stagedVideosByCamera.set(id, file.path);

    const loop = req.body?.loop !== 'false' && req.body?.loop !== false;
    const originalName = path.basename(file.originalname || file.filename);
    const sourceKey = `file:${originalName}`;

    const profile = await prisma.zoneProfile
      .findUnique({ where: { sourceKey } })
      .catch(() => null);

    await prisma.camera
      .upsert({
        where: { id },
        update: {
          isActive: true,
          lastSeenAt: new Date(),
          activeSourceKey: sourceKey,
          activeZoneProfileId: profile?.id ?? null,
          metadata: {
            sourceType: 'uploaded_video',
            sourceKey,
            label: originalName,
            loop,
          },
        },
        create: {
          id,
          name: `Camera ${id}`,
          location: 'Intersection',
          isActive: true,
          lastSeenAt: new Date(),
          activeSourceKey: sourceKey,
          activeZoneProfileId: profile?.id ?? null,
          metadata: {
            sourceType: 'uploaded_video',
            sourceKey,
            label: originalName,
            loop,
          },
        },
      })
      .catch(() => {});

    wsManager.setInferenceMode(id, 'uploaded_video');
    wsManager.clearPendingFrame(id);

    wsManager.sendToInference(id, {
      type: 'zone_update',
      cameraId: id,
      zones: profile ?? {
        sourceKey,
        lanes: [],
        intersection: [],
        exitZones: [],
        lightBox: [],
        crossingMode: false,
        clearanceSeconds: 3.0,
      },
    });

    const downloadPath = `/api/cameras/${encodeURIComponent(id)}/video/${encodeURIComponent(
      file.filename
    )}`;
    wsManager.sendToInference(id, {
      type: 'switch_source',
      cameraId: id,
      sourceType: 'uploaded_video',
      sourceValue: originalName,
      filename: file.filename,
      downloadPath,
      sourceKey,
      loop,
    });

    wsManager.broadcastToClients({
      type: 'camera_profile_switched',
      cameraId: id,
      sourceKey,
      config: profile ?? null,
      timestamp: Date.now(),
    });

    console.log(
      `📦 [Camera Video] Staged '${originalName}' (${(file.size / (1024 * 1024)).toFixed(1)} MB) for '${id}' -> pushing to AI Engine`
    );

    res.status(201).json({
      cameraId: id,
      filename: file.filename,
      originalName,
      sourceKey,
      loop,
      sizeBytes: file.size,
    });
  } catch (err) {
    next(err);
  }
}

export async function downloadStagedCameraVideo(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { id, filename } = req.params;
    const safeName = path.basename(filename);
    const tempDir = path.join(config.uploadDir, 'temp_videos');
    const filePath = path.join(tempDir, safeName);

    if (!fs.existsSync(filePath)) {
      res.status(404).json({ error: `Staged video '${safeName}' not found` });
      return;
    }

    const stat = await fs.promises.stat(filePath);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Length', stat.size);

    const shouldCleanup = req.query.cleanup === '1' || req.query.cleanup === 'true';
    res.on('finish', () => {
      if (shouldCleanup && res.statusCode === 200) {
        if (stagedVideosByCamera.get(id) === filePath) {
          stagedVideosByCamera.delete(id);
        }
        void fs.promises.unlink(filePath).catch(() => {});
        console.log(`🧹 [Camera Video] Deleted staged copy '${safeName}' after AI Engine pull`);
      }
    });

    const stream = fs.createReadStream(filePath);
    stream.on('error', (err) => {
      next(err);
    });
    stream.pipe(res);
  } catch (err) {
    next(err);
  }
}

export async function stopCameraVideoSource(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { id } = req.params;
    cleanupStagedVideoForCamera(id);
    wsManager.clearPendingFrame(id);
    wsManager.sendToInference(id, { type: 'stop_source', cameraId: id });
    res.json({ stopped: true, cameraId: id });
  } catch (err) {
    next(err);
  }
}

const updateZoneSchema = z.object({
  sourceKey: z.string().trim().min(1).optional(),
  name: z.string().trim().min(1).optional(),
  lanes: z.array(z.any()),
  intersection: z.array(z.any()),
  exitZones: z.array(z.any()).optional().default([]),
  lightBox: z.any().optional(),
  crossingMode: z.boolean().optional().default(false),
  clearanceSeconds: z.number().min(0).max(15).optional().default(3.0),
});

export async function updateZoneConfig(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { id } = req.params;
    const data = updateZoneSchema.parse(req.body);

    const existingCam = await prisma.camera.findUnique({
      where: { id },
      select: { id: true, name: true, activeSourceKey: true },
    });

    const effectiveSourceKey =
      data.sourceKey || existingCam?.activeSourceKey || `camera:${id}`;
    const profileName =
      data.name ||
      effectiveSourceKey.replace(/^(file|webcam|camera):/, '') ||
      existingCam?.name ||
      id;

    const profile = await prisma.zoneProfile.upsert({
      where: { sourceKey: effectiveSourceKey },
      update: {
        name: profileName,
        lanes: data.lanes,
        intersection: data.intersection,
        exitZones: data.exitZones,
        lightBox: data.lightBox || [],
        crossingMode: data.crossingMode,
        clearanceSeconds: data.clearanceSeconds,
        version: { increment: 1 },
      },
      create: {
        sourceKey: effectiveSourceKey,
        name: profileName,
        lanes: data.lanes,
        intersection: data.intersection,
        exitZones: data.exitZones,
        lightBox: data.lightBox || [],
        crossingMode: data.crossingMode,
        clearanceSeconds: data.clearanceSeconds,
        version: 1,
      },
    });

    await prisma.camera.upsert({
      where: { id },
      update: {
        activeSourceKey: effectiveSourceKey,
        activeZoneProfileId: profile.id,
      },
      create: {
        id,
        name: existingCam?.name || `Camera ${id}`,
        location: 'Intersection',
        isActive: false,
        activeSourceKey: effectiveSourceKey,
        activeZoneProfileId: profile.id,
      },
    });

    // Sync any other cameras currently running the exact same video sourceKey
    const siblingCameras = await prisma.camera.findMany({
      where: { activeSourceKey: effectiveSourceKey, id: { not: id } },
      select: { id: true },
    });
    if (siblingCameras.length > 0) {
      await prisma.camera.updateMany({
        where: { activeSourceKey: effectiveSourceKey, id: { not: id } },
        data: { activeZoneProfileId: profile.id },
      });
    }

    const sent = wsManager.sendToInference(id, {
      type: 'zone_update',
      cameraId: id,
      zones: profile,
    });

    for (const sib of siblingCameras) {
      wsManager.sendToInference(sib.id, {
        type: 'zone_update',
        cameraId: sib.id,
        zones: profile,
      });
    }

    console.log(
      `💾 [ZoneProfile] Saved profile '${profile.sourceKey}' (v${profile.version}, crossingMode=${profile.crossingMode}) for camera '${id}' (syncedWithAI=${sent})`
    );

    wsManager.broadcastToClients({
      type: 'camera_profile_switched',
      cameraId: id,
      sourceKey: profile.sourceKey,
      config: profile,
      timestamp: Date.now(),
    });

    res.json({
      config: profile,
      syncedWithAI: sent,
      message: sent
        ? `ZoneProfile '${profile.sourceKey}' saved and synced to AI engine.`
        : `ZoneProfile '${profile.sourceKey}' saved. (AI engine offline, will sync on connect)`,
    });
  } catch (err) {
    next(err);
  }
}
