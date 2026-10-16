import { Router } from 'express';
import {
  listViolations,
  getViolation,
  updateViolationStatus,
} from '../controllers/violation.controller.js';
import { authenticateToken } from '../middlewares/auth.middleware.js';

const router = Router();

router.get('/', listViolations);
router.get('/:id', getViolation);
router.patch('/:id/status', authenticateToken, updateViolationStatus);


export default router;
