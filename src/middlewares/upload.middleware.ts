import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { config } from '../config/env.js';

const evidenceUploadDir = path.join(config.uploadDir, 'evidence');
const tempVideoUploadDir = path.join(config.uploadDir, 'temp_videos');
fs.mkdirSync(evidenceUploadDir, { recursive: true });
fs.mkdirSync(tempVideoUploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, evidenceUploadDir);
  },
  filename: (_req, file, cb) => {
    // Preserve original filename if it's a violation clip for deterministic on-demand retrieval
    if (file.originalname.startsWith('violation_')) {
      cb(null, file.originalname);
      return;
    }
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

const tempVideoStorage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, tempVideoUploadDir);
  },
  filename: (req, file, cb) => {
    const rawCamId = String(req.params?.id || 'cam-01').replace(/[^a-zA-Z0-9_-]/g, '_');
    const ext = path.extname(file.originalname).toLowerCase() || '.mp4';
    const base = path
      .basename(file.originalname, ext)
      .replace(/[^a-zA-Z0-9_-]/g, '_')
      .slice(0, 64);
    cb(null, `${rawCamId}_${Date.now()}_${base || 'video'}${ext}`);
  },
});

export const uploadCameraVideo = multer({
  storage: tempVideoStorage,
  limits: {
    fileSize: Math.max(config.maxFileSizeMb, 500) * 1024 * 1024,
  },
  fileFilter: (_req, file, cb) => {
    const allowedExtensions = ['.mp4', '.mov', '.mkv', '.avi', '.webm'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowedExtensions.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error(`Unsupported video type: ${ext}. Allowed: mp4, mov, mkv, avi, webm`));
    }
  },
});
