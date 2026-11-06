import { Router } from 'express';
import { Role } from '@prisma/client';
import {
  listViolations,
  getViolation,
  updateViolationStatus,
} from '../controllers/violation.controller.js';
import { authenticateToken, requireRole } from '../middlewares/auth.middleware.js';

const router = Router();

router.get('/', authenticateToken, listViolations);
router.get('/:id', authenticateToken, getViolation);
router.patch('/:id/status', authenticateToken, requireRole(Role.POLICE), updateViolationStatus);

export default router;
