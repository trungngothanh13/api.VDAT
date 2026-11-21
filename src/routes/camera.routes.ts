import { Router } from 'express';
import {
  listCameras,
  listZoneProfiles,
  getCamera,
  createCamera,
  updateZoneConfig,
} from '../controllers/camera.controller.js';
import { authenticateToken, requireRole } from '../middlewares/auth.middleware.js';
import { Role } from '@prisma/client';

const router = Router();

router.get('/', authenticateToken, listCameras);
router.get('/profiles', authenticateToken, listZoneProfiles);
router.post('/', authenticateToken, requireRole(Role.ADMIN), createCamera);
router.get('/:id', authenticateToken, getCamera);
router.put('/:id/zones', authenticateToken, requireRole(Role.ADMIN), updateZoneConfig);

export default router;
