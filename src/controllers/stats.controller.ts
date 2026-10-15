import { Request, Response, NextFunction } from 'express';
import { prisma } from '../config/prisma.js';
import { wsManager } from '../websocket/ws.manager.js';

export async function getOverviewStats(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const [total, pending, confirmed, dismissed, classCounts, cameraCounts, recent] =
      await Promise.all([
        prisma.violation.count(),
        prisma.violation.count({ where: { status: 'PENDING_REVIEW' } }),
        prisma.violation.count({ where: { status: 'CONFIRMED' } }),
        prisma.violation.count({ where: { status: 'DISMISSED' } }),
        prisma.violation.groupBy({
          by: ['vehicleClass'],
          _count: { _all: true },
        }),
        prisma.violation.groupBy({
          by: ['cameraId'],
          _count: { _all: true },
        }),
        prisma.violation.findMany({
          take: 5,
          orderBy: { createdAt: 'desc' },
          include: { camera: { select: { name: true } } },
        }),
      ]);

    const activeCameras = wsManager.getActiveCameras();

    res.json({
      summary: {
        totalViolations: total,
        pendingReview: pending,
        confirmed,
        dismissed,
        activeCamerasCount: activeCameras.length,
      },
      byVehicleClass: classCounts.map((c) => ({
        class: c.vehicleClass,
        count: c._count._all,
      })),
      byCamera: cameraCounts.map((c) => ({
        cameraId: c.cameraId,
        count: c._count._all,
      })),
      recentViolations: recent,
    });
  } catch (err) {
    next(err);
  }
}
