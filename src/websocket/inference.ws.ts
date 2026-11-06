import { WebSocket } from 'ws';
import fs from 'fs';
import path from 'path';
import { prisma } from '../config/prisma.js';
import { config } from '../config/env.js';
import { wsManager } from './ws.manager.js';
import { enforceEvidenceCacheLimits } from '../routes/evidence.routes.js';

const evidenceDir = path.join(config.uploadDir, 'evidence');
fs.mkdirSync(evidenceDir, { recursive: true });

export function handleInferenceConnection(ws: WebSocket): void {
  let boundCameraId: string | null = null;

  console.log('[Inference WS] New connection received from AI Engine.');

  ws.on('message', async (data: Buffer | string) => {
    try {
      const message = JSON.parse(data.toString());

      switch (message.type) {
        case 'camera_init': {
          const { cameraId, pipeline, ingestMode } = message;
          boundCameraId = cameraId;
          const resolvedMode = ingestMode || pipeline?.ingestMode || 'local';
          wsManager.registerInference(cameraId, ws, resolvedMode);

          // Update camera in DB
          const camera = await prisma.camera.upsert({
            where: { id: cameraId },
            update: {
              isActive: true,
              lastSeenAt: new Date(),
              metadata: pipeline || {},
            },
            create: {
              id: cameraId,
              name: `Camera ${cameraId}`,
              location: 'Intersection',
              isActive: true,
              lastSeenAt: new Date(),
              metadata: pipeline || {},
            },
            include: { config: true },
          });

          // Send acknowledgment and current zone config to AI engine
          ws.send(
            JSON.stringify({
              type: 'camera_ack',
              status: 'OK',
              cameraId,
              zones: camera.config || null,
            })
          );
          break;
        }

        case 'frame': {
          // Relay frame and telemetry directly to web clients
          wsManager.broadcastToClients({
            type: 'live_frame',
            cameraId: message.cameraId,
            telemetry: message.telemetry,
            image: message.image,
            timestamp: Date.now(),
          });
          break;
        }

        case 'violation': {
          const { cameraId, event, evidenceImage } = message;

          let snapshotUrl: string | null = null;

          // Save base64 snapshot to disk if present
          if (evidenceImage) {
            const filename = `snapshot_${cameraId}_id${event.track_id}_f${event.frame_number}.jpg`;
            const filepath = path.join(evidenceDir, filename);
            const buffer = Buffer.from(evidenceImage, 'base64');
            fs.writeFileSync(filepath, buffer);
            snapshotUrl = `/uploads/evidence/${filename}`;
            enforceEvidenceCacheLimits();
          }

          // Ensure camera exists (in case violation arrives before camera_init)
          await prisma.camera.upsert({
            where: { id: cameraId },
            update: { lastSeenAt: new Date() },
            create: {
              id: cameraId,
              name: `Camera ${cameraId}`,
              location: 'Unknown',
              isActive: true,
              lastSeenAt: new Date(),
            },
          });

          // Persist violation into PostgreSQL
          const record = await prisma.violation.create({
            data: {
              cameraId,
              trackId: event.track_id,
              vehicleClass: event.vehicle_class,
              classId: event.class_id,
              frameNumber: event.frame_number,
              timestamp: event.timestamp || `${event.frame_number}`,
              lightState: event.light_state || 'red',
              bbox: event.bbox || [],
              confidence: event.confidence || null,
              snapshotUrl,
            },
          });

          console.log(`🚨 [Inference WS] Violation saved to DB: Vehicle #${event.track_id} (${event.vehicle_class})`);

          // Broadcast alert to all active dashboard users
          wsManager.broadcastToClients({
            type: 'violation_alert',
            violation: record,
          });
          break;
        }

        case 'evidence_clip_ready': {
          const { cameraId, event, clipPath, filename: msgFilename } = message;
          const filename = msgFilename || path.basename(clipPath);
          const evidenceClipUrl = `/api/evidence/stream/${cameraId}/${filename}`;

          // Find and update the violation record
          await prisma.violation.updateMany({
            where: {
              cameraId,
              trackId: event.track_id,
              frameNumber: event.frame_number,
            },
            data: {
              evidenceClipUrl,
            },
          });

          console.log(`📹 [Inference WS] On-demand evidence clip registered for track #${event.track_id}: ${evidenceClipUrl}`);

          // Broadcast clip update to clients
          wsManager.broadcastToClients({
            type: 'evidence_clip_update',
            cameraId,
            trackId: event.track_id,
            frameNumber: event.frame_number,
            evidenceClipUrl,
          });
          break;
        }

        default:
          console.warn(`[Inference WS] Unknown message type: ${message.type}`);
      }
    } catch (err) {
      console.error('[Inference WS] Message handling error:', err);
    }
  });

  ws.on('close', () => {
    if (boundCameraId) {
      wsManager.unregisterInference(boundCameraId);
      prisma.camera
        .update({
          where: { id: boundCameraId },
          data: { isActive: false },
        })
        .catch(() => {});
    }
  });

  ws.on('error', (err) => {
    console.error(`[Inference WS] Connection error:`, err);
  });
}
