import { Router } from 'express';
import { uploadEvidence } from '../middlewares/upload.middleware.js';
import { streamEvidenceClip, uploadEvidenceFile } from '../controllers/evidence.controller.js';

const router = Router();

router.get('/stream/:cameraId/:filename', streamEvidenceClip);
router.get('/download/:cameraId/:filename', streamEvidenceClip);
router.post('/upload', uploadEvidence.single('file'), uploadEvidenceFile);

export default router;
