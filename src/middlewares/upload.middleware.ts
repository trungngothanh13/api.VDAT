import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { config } from '../config/env.js';

const evidenceUploadDir = path.join(config.uploadDir, 'evidence');
fs.mkdirSync(evidenceUploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, evidenceUploadDir);
  },
  filename: (_req, file, cb) => {
    // Preserve original filename or generate unique name
    const ext = path.extname(file.originalname);
    const basename = path.basename(file.originalname, ext).replace(/[^a-zA-Z0-9_-]/g, '_');
    const timestamp = Date.now();
    cb(null, `${basename}_${timestamp}${ext}`);
  },
});

export const uploadEvidence = multer({
  storage,
  limits: {
    fileSize: config.maxFileSizeMb * 1024 * 1024,
  },
  fileFilter: (_req, file, cb) => {
    const allowedExtensions = ['.jpg', '.jpeg', '.png', '.mp4'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowedExtensions.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error(`Unsupported file type: ${ext}. Allowed: jpg, jpeg, png, mp4`));
    }
  },
});
