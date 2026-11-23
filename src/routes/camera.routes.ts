import { Router } from 'express';
import {
  listCameras,
  listZoneProfiles,
  getCamera,
  createCamera,
  deleteCamera,
  deleteCameras,
  updateZoneConfig,
  uploadCameraVideoSource,
  downloadStagedCameraVideo,
  stopCameraVideoSource,
} from '../controllers/camera.controller.js';
import { authenticateToken, requireRole } from '../middlewares/auth.middleware.js';
import { uploadCameraVideo } from '../middlewares/upload.middleware.js';
import { Role } from '@prisma/client';

const router = Router();

router.get('/', authenticateToken, listCameras);
router.get('/profiles', authenticateToken, listZoneProfiles);
router.post('/', authenticateToken, requireRole(Role.ADMIN), createCamera);
router.post('/delete', authenticateToken, requireRole(Role.ADMIN), deleteCameras);
router.post('/:id/video', authenticateToken, uploadCameraVideo.single('file'), uploadCameraVideoSource);
router.get('/:id/video/:filename', downloadStagedCameraVideo);
router.delete('/:id/video', authenticateToken, stopCameraVideoSource);
router.get('/:id', authenticateToken, getCamera);
router.delete('/:id', authenticateToken, requireRole(Role.ADMIN), deleteCamera);
router.put('/:id/zones', authenticateToken, requireRole(Role.ADMIN), updateZoneConfig);

export default router;
