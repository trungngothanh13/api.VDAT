import { Router } from 'express';
import { listCameras, getCamera, updateZoneConfig } from '../controllers/camera.controller.js';
import { authenticateToken, requireRole } from '../middlewares/auth.middleware.js';
import { Role } from '@prisma/client';

const router = Router();

router.get('/', authenticateToken, listCameras);
router.get('/:id', authenticateToken, getCamera);
router.put('/:id/zones', authenticateToken, requireRole(Role.ADMIN), updateZoneConfig);

export default router;
