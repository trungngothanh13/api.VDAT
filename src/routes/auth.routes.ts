import { Router } from 'express';
import { login, getMe } from '../controllers/auth.controller.js';
import { authenticateToken } from '../middlewares/auth.middleware.js';

const router = Router();

router.post('/login', login);
router.get('/me', authenticateToken, getMe);

export default router;
