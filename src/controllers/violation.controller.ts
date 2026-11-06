import { Response, NextFunction } from 'express';
import fs from 'fs';
import path from 'path';
import { z } from 'zod';
import { ViolationStatus } from '@prisma/client';
import { prisma } from '../config/prisma.js';
import { config } from '../config/env.js';
import { AuthRequest } from '../middlewares/auth.middleware.js';

export async function listViolations(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const page = parseInt(req.query.page as string || '1', 10);
    const limit = parseInt(req.query.limit as string || '20', 10);
    const skip = (page - 1) * limit;

    const { cameraId, status, vehicleClass, startDate, endDate } = req.query;

    const where: any = {};
    if (cameraId) where.cameraId = String(cameraId);
    if (status && Object.values(ViolationStatus).includes(status as ViolationStatus)) {
      where.status = status as ViolationStatus;
    }
    if (vehicleClass) where.vehicleClass = String(vehicleClass);

    if (startDate || endDate) {
      where.createdAt = {};
      if (startDate) where.createdAt.gte = new Date(String(startDate));
      if (endDate) where.createdAt.lte = new Date(String(endDate));
    }

    const [violations, total] = await Promise.all([
      prisma.violation.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          camera: { select: { id: true, name: true, location: true } },
          reviewedBy: { select: { id: true, fullName: true, email: true } },
        },
      }),
      prisma.violation.count({ where }),
    ]);

    res.json({
      data: violations,
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (err) {
    next(err);
  }
}

export async function getViolation(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const { id } = req.params;
    const violation = await prisma.violation.findUnique({
      where: { id },
      include: {
        camera: true,
        reviewedBy: { select: { id: true, fullName: true, email: true } },
      },
    });

    if (!violation) {
      res.status(404).json({ error: 'Violation record not found' });
      return;
    }

    res.json(violation);
  } catch (err) {
    next(err);
  }
}

const updateStatusSchema = z.object({
  status: z.enum([ViolationStatus.CONFIRMED, ViolationStatus.DISMISSED]),
  notes: z.string().optional(),
});

export async function updateViolationStatus(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const { id } = req.params;
    const { status, notes } = updateStatusSchema.parse(req.body);

    const updated = await prisma.violation.update({
      where: { id },
      data: {
        status,
        notes,
        reviewedById: req.user?.id,
        reviewedAt: new Date(),
      },
      include: {
        reviewedBy: { select: { id: true, fullName: true } },
      },
    });

    // If a violation is dismissed, immediately purge any cached temporary video clip on disk
    if (status === ViolationStatus.DISMISSED) {
      const clipName = `violation_${updated.cameraId}_id${updated.trackId}_f${updated.frameNumber}.mp4`;
      const clipPath = path.join(config.uploadDir, 'evidence', clipName);
      try {
        if (fs.existsSync(clipPath)) {
          fs.unlinkSync(clipPath);
        }
      } catch {
        // Ignore cleanup errors
      }
    }

    res.json(updated);
  } catch (err) {
    next(err);
  }
}
