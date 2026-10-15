import { Router } from 'express';
import { getOverviewStats } from '../controllers/stats.controller.js';
import { authenticateToken } from '../middlewares/auth.middleware.js';

const router = Router();

router.get('/overview', authenticateToken, getOverviewStats);

export default router;
