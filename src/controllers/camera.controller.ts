import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '../config/prisma.js';
import { wsManager } from '../websocket/ws.manager.js';

export async function listCameras(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const cameras = await prisma.camera.findMany({
      include: {
        config: true,
        _count: {
          select: { violations: true },
        },
      },
      orderBy: { id: 'asc' },
    });

    const activeCameras = new Set(wsManager.getActiveCameras());

    const result = cameras.map((cam) => ({
      ...cam,
      isLive: activeCameras.has(cam.id),
      violationCount: cam._count.violations,
    }));

    res.json(result);
  } catch (err) {
    next(err);
  }
}

export async function getCamera(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { id } = req.params;
    const camera = await prisma.camera.findUnique({
      where: { id },
      include: { config: true },
    });

    if (!camera) {
      res.status(404).json({ error: 'Camera not found' });
      return;
    }

    const activeCameras = new Set(wsManager.getActiveCameras());
    res.json({
      ...camera,
      isLive: activeCameras.has(camera.id),
    });
  } catch (err) {
    next(err);
  }
}

const updateZoneSchema = z.object({
  lanes: z.array(z.any()),
  intersection: z.array(z.any()),
  lightBox: z.any().optional(),
});

export async function updateZoneConfig(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { id } = req.params;
    const data = updateZoneSchema.parse(req.body);

    const config = await prisma.cameraConfig.upsert({
      where: { cameraId: id },
      update: {
        lanes: data.lanes,
        intersection: data.intersection,
        lightBox: data.lightBox || null,
        version: { increment: 1 },
      },
      create: {
        cameraId: id,
        lanes: data.lanes,
        intersection: data.intersection,
        lightBox: data.lightBox || null,
        version: 1,
      },
    });

    // Notify connected AI Engine on ThunderCompute about updated zones
    const sent = wsManager.sendToInference(id, {
      type: 'zone_update',
      cameraId: id,
      zones: config,
    });

    res.json({
      config,
      syncedWithAI: sent,
      message: sent
        ? 'Zone configuration updated and synced with AI engine.'
        : 'Zone configuration updated. (AI engine not currently connected, will sync on connect)',
    });
  } catch (err) {
    next(err);
  }
}
