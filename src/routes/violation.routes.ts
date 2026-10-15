import { Router } from 'express';
import {
  listViolations,
  getViolation,
  updateViolationStatus,
} from '../controllers/violation.controller.js';
import { authenticateToken } from '../middlewares/auth.middleware.js';

const router = Router();

router.get('/', authenticateToken, listViolations);
router.get('/:id', authenticateToken, getViolation);
router.patch('/:id/status', authenticateToken, updateViolationStatus);

export default router;
