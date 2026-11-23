import { RawData, WebSocket } from 'ws';
import fs from 'fs';
import path from 'path';
import { prisma } from '../config/prisma.js';
import { config } from '../config/env.js';
import { wsManager } from './ws.manager.js';
import { encodeBinaryFrame, parseBinaryFrame } from './binary-frame.js';
import { enforceEvidenceCacheLimits } from '../routes/evidence.routes.js';

const evidenceDir = path.join(config.uploadDir, 'evidence');
fs.mkdirSync(evidenceDir, { recursive: true });

function rawDataToBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

export function handleInferenceConnection(ws: WebSocket): void {
  let boundCameraId: string | null = null;

  console.log('[Inference WS] New connection received from AI Engine.');

  ws.on('message', async (data: RawData, isBinary: boolean) => {
    try {
      if (isBinary) {
        const buf = rawDataToBuffer(data);
        const parsed = parseBinaryFrame(buf);
        if (!parsed) return;

        if (parsed.header.type === 'frame') {
          const cameraId = parsed.header.cameraId || boundCameraId || 'cam-01';
          const ackSeq = typeof parsed.header.ackSeq === 'number' ? parsed.header.ackSeq : undefined;
          const ackedFrames = typeof parsed.header.ackedFrames === 'number' ? parsed.header.ackedFrames : 1;
          wsManager.ackInferenceFrame(cameraId, ackSeq, ackedFrames);
          if (parsed.payload.length > 0) {
            if (parsed.header.telemetry) {
              wsManager.broadcastTelemetryToUnfocusedClients(cameraId, parsed.header.telemetry);
            }
            const outBuf = encodeBinaryFrame(
              {
                type: 'live_frame',
                cameraId,
                telemetry: parsed.header.telemetry,
                timestamp: Date.now(),
              },
              parsed.payload
            );
            wsManager.broadcastFrameToFocusedClients(cameraId, outBuf);
          } else if (parsed.header.telemetry) {
            wsManager.broadcastTelemetryToClients(cameraId, parsed.header.telemetry);
          }
        }
        return;
      }

      const message = JSON.parse(data.toString());

      switch (message.type) {
        case 'camera_init': {
          const { cameraId, pipeline, ingestMode } = message;
          boundCameraId = cameraId;
          const resolvedMode = ingestMode || pipeline?.ingestMode || 'local';
          wsManager.registerInference(cameraId, ws, resolvedMode);

          if (pipeline?.modelProfile || pipeline?.model) {
            const prof = pipeline.modelProfile === 'stock' ? 'stock' : 'trained';
            const updatedStatus = wsManager.setActiveModelStatus({
              profile: prof,
              modelName: pipeline.model ? path.basename(String(pipeline.model)) : prof === 'stock' ? 'yolo26l.pt' : 'best.pt',
              confidence: typeof pipeline.confidence === 'number' ? pipeline.confidence : undefined,
              switching: false,
            });
            wsManager.broadcastToClients({
              type: 'ai_model_status',
              ...updatedStatus,
              timestamp: Date.now(),
            });
          }

          if (pipeline?.tracker) {
            const rawTracker = String(pipeline.tracker).toLowerCase();
            const normalizedTracker =
              rawTracker === 'botsort' || rawTracker === 'deepsort' ? rawTracker : 'bytetrack';
            const updatedTracker = wsManager.setActiveTrackerStatus({
              tracker: normalizedTracker,
              switching: false,
            });
            wsManager.broadcastToClients({
              type: 'ai_tracker_status',
              ...updatedTracker,
              timestamp: Date.now(),
            });
          }

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
            include: { activeZoneProfile: true },
          });

          // Send acknowledgment and current active ZoneProfile to AI engine
          ws.send(
            JSON.stringify({
              type: 'camera_ack',
              status: 'OK',
              cameraId,
              zones: camera.activeZoneProfile || null,
            })
          );
          break;
        }

        case 'frame': {
          const ackSeq = typeof message.ackSeq === 'number' ? message.ackSeq : undefined;
          const ackedFrames = typeof message.ackedFrames === 'number' ? message.ackedFrames : 1;
          wsManager.ackInferenceFrame(message.cameraId, ackSeq, ackedFrames);

          // Always send lightweight telemetry for all cameras (for Multi-Source Wall status)
          wsManager.broadcastTelemetryToClients(message.cameraId, message.telemetry);

          // Send heavy AI-annotated frame only if an image was attached and clients focus on this camera
          if (message.image) {
            wsManager.broadcastFrameToFocusedClients(message.cameraId, {
              type: 'live_frame',
              cameraId: message.cameraId,
              telemetry: message.telemetry,
              image: message.image,
              timestamp: Date.now(),
            });
          }
          break;
        }

        case 'frame_overlay': {
          const cameraId = message.cameraId || boundCameraId || 'cam-01';
          const ackSeq = typeof message.ackSeq === 'number' ? message.ackSeq : undefined;
          const ackedFrames = typeof message.ackedFrames === 'number' ? message.ackedFrames : 1;
          wsManager.ackInferenceFrame(cameraId, ackSeq, ackedFrames);
          if (message.telemetry) {
            wsManager.broadcastTelemetryToUnfocusedClients(cameraId, message.telemetry);
          }
          if (message.overlay) {
            wsManager.broadcastOverlayToFocusedClients(cameraId, {
              type: 'live_overlay',
              cameraId,
              overlay: message.overlay,
              telemetry: message.telemetry,
              timestamp: Date.now(),
            });
          }
          break;
        }

        case 'source_status': {
          const cameraId = message.cameraId || boundCameraId || 'cam-01';
          wsManager.broadcastToClients({
            type: 'camera_source_status',
            cameraId,
            status: message.status,
            sourceType: message.sourceType,
            label: message.label,
            error: message.error,
            timestamp: Date.now(),
          });
          break;
        }

        case 'frame_ack': {
          const cameraId = message.cameraId || boundCameraId;
          if (cameraId) {
            const ackSeq = typeof message.ackSeq === 'number' ? message.ackSeq : undefined;
            wsManager.ackInferenceFrame(
              cameraId,
              ackSeq,
              typeof message.count === 'number' ? message.count : 1
            );
          }
          break;
        }

        case 'violation': {
          const { cameraId, event, evidenceImage } = message;

          let snapshotUrl: string | null = null;

          // Save base64 snapshot asynchronously so the WebSocket event loop stays responsive
          if (evidenceImage) {
            const filename = `snapshot_${cameraId}_id${event.track_id}_f${event.frame_number}.jpg`;
            const filepath = path.join(evidenceDir, filename);
            const buffer = Buffer.from(evidenceImage, 'base64');
            await fs.promises.writeFile(filepath, buffer);
            snapshotUrl = `/uploads/evidence/${filename}`;
            setImmediate(() => {
              void enforceEvidenceCacheLimits();
            });
          }

          // Ensure camera exists and capture its active ZoneProfile linkage
          const cam = await prisma.camera.upsert({
            where: { id: cameraId },
            update: { lastSeenAt: new Date() },
            create: {
              id: cameraId,
              name: `Camera ${cameraId}`,
              location: 'Unknown',
              isActive: true,
              lastSeenAt: new Date(),
            },
            select: {
              activeZoneProfileId: true,
              activeSourceKey: true,
            },
          });

          // Persist violation into PostgreSQL
          const record = await prisma.violation.create({
            data: {
              cameraId,
              zoneProfileId: cam.activeZoneProfileId ?? null,
              sourceKey: cam.activeSourceKey ?? null,
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

          console.log(`🚨 [Inference WS] Violation saved to DB (${cameraId}): Vehicle #${event.track_id} (${event.vehicle_class})`);

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

        case 'model_status': {
          const prof = message.profile === 'stock' ? 'stock' : 'trained';
          const updatedStatus = wsManager.setActiveModelStatus({
            profile: prof,
            modelName: String(message.modelName || (prof === 'stock' ? 'yolo26l.pt' : 'best.pt')),
            confidence: typeof message.confidence === 'number' ? message.confidence : undefined,
            switching: Boolean(message.switching),
          });
          console.log(
            `🔁 [Inference WS] Active AI model switched -> ${updatedStatus.profile} (${updatedStatus.modelName})`
          );
          wsManager.broadcastToClients({
            type: 'ai_model_status',
            ...updatedStatus,
            timestamp: Date.now(),
          });
          break;
        }

        case 'tracker_status': {
          const rawTracker = String(message.tracker || 'bytetrack').toLowerCase();
          const normalizedTracker =
            rawTracker === 'botsort' || rawTracker === 'deepsort' ? rawTracker : 'bytetrack';
          const updatedTracker = wsManager.setActiveTrackerStatus({
            tracker: normalizedTracker,
            switching: Boolean(message.switching),
          });
          console.log(`🧭 [Inference WS] Active AI tracker switched -> ${updatedTracker.tracker}`);
          wsManager.broadcastToClients({
            type: 'ai_tracker_status',
            ...updatedTracker,
            timestamp: Date.now(),
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
