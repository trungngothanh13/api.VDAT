import { RawData, WebSocket } from 'ws';
import { prisma } from '../config/prisma.js';
import { wsManager } from './ws.manager.js';
import { parseBinaryFrame } from './binary-frame.js';
import { cleanupStagedVideoForCamera } from '../controllers/camera.controller.js';

function rawDataToBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

export function handleClientConnection(ws: WebSocket): void {
  wsManager.registerClient(ws);

  // Send initial handshake with active camera list, previews, model profile, and tracking engine
  ws.send(
    JSON.stringify({
      type: 'connection_established',
      activeCameras: wsManager.getActiveCameras(),
      cameraPreviews: wsManager.getCameraPreviews(),
      bypassZonesByCamera: wsManager.getCameraBypassZonesMap(),
      modelStatus: wsManager.getActiveModelStatus(),
      trackerStatus: wsManager.getActiveTrackerStatus(),
      timestamp: Date.now(),
    })
  );

  ws.on('message', async (data: RawData, isBinary: boolean) => {
    try {
      if (isBinary) {
        const buf = rawDataToBuffer(data);
        const parsed = parseBinaryFrame(buf);
        if (!parsed) return;
        if (parsed.header.type === 'source_frame') {
          const cameraId = parsed.header.cameraId || 'cam-01';
          if (wsManager.hasActiveInference(cameraId)) {
            wsManager.setInferenceMode(cameraId, 'ws');
            wsManager.enqueueFrameForInference(cameraId, {
              header: parsed.header,
              payload: parsed.payload,
            });
          }
        }
        return;
      }

      const msg = JSON.parse(data.toString());

      switch (msg.type) {
        case 'ping': {
          ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
          break;
        }

        case 'watch_camera': {
          const cameraId = msg.cameraId || 'cam-01';
          wsManager.setClientFocusCamera(ws, cameraId);
          break;
        }

        case 'source_init': {
          const cameraId = msg.cameraId || 'cam-01';
          const sourceKey =
            (typeof msg.sourceKey === 'string' && msg.sourceKey.trim()) ||
            (typeof msg.label === 'string' && msg.label.trim()
              ? `file:${msg.label.trim()}`
              : `camera:${cameraId}`);

          wsManager.registerWebSource(cameraId, ws);
          wsManager.setInferenceMode(cameraId, 'ws');

          const profile = await prisma.zoneProfile
            .findUnique({ where: { sourceKey } })
            .catch(() => null);

          await prisma.camera
            .upsert({
              where: { id: cameraId },
              update: {
                isActive: true,
                lastSeenAt: new Date(),
                activeSourceKey: sourceKey,
                activeZoneProfileId: profile?.id ?? null,
                metadata: {
                  sourceType: msg.sourceType || 'web_stream',
                  sourceKey,
                  label: msg.label || 'Web Camera Stream',
                  fps: msg.fps || 15,
                  width: msg.width || 854,
                  height: msg.height || 480,
                },
              },
              create: {
                id: cameraId,
                name: msg.label || `Camera ${cameraId}`,
                location: 'Web Stream Transmitter',
                isActive: true,
                lastSeenAt: new Date(),
                activeSourceKey: sourceKey,
                activeZoneProfileId: profile?.id ?? null,
                metadata: {
                  sourceType: msg.sourceType || 'web_stream',
                  sourceKey,
                  fps: msg.fps || 15,
                  width: msg.width || 854,
                  height: msg.height || 480,
                },
              },
            })
            .catch(() => {});

          if (wsManager.hasActiveInference(cameraId)) {
            console.log(
              `[Client WS] Web source (${sourceKey}) initialized -> routing to connected AI Engine (${cameraId})`
            );
            wsManager.sendToInference(cameraId, {
              type: 'switch_source',
              cameraId,
              sourceType: 'web_stream',
              sourceValue: msg.label || sourceKey,
              sourceKey,
              loop: true,
            });
            // Auto-apply saved ZoneProfile or reset stale zones when switching sources
            wsManager.sendToInference(cameraId, {
              type: 'zone_update',
              cameraId,
              zones: profile ?? {
                sourceKey,
                lanes: [],
                intersection: [],
                exitZones: [],
                lightBox: [],
                crossingMode: false,
                clearanceSeconds: 3.0,
              },
            });
          } else {
            console.warn(
              `[Client WS] Web source (${sourceKey}) initialized for ${cameraId}, but NO Python AI Engine is connected to /ws/inference`
            );
          }

          wsManager.broadcastToClients({
            type: 'camera_profile_switched',
            cameraId,
            sourceKey,
            config: profile ?? null,
            timestamp: Date.now(),
          });
          break;
        }

        case 'source_frame': {
          const cameraId = msg.cameraId || 'cam-01';
          const image = msg.image;
          if (!image) break;

          // Only forward frames when the Python AI Engine is connected.
          // Never echo raw unannotated browser frames back as live_frame!
          if (wsManager.hasActiveInference(cameraId)) {
            wsManager.setInferenceMode(cameraId, 'ws');
            wsManager.enqueueFrameForInference(cameraId, {
              header: {
                type: 'ingest_frame',
                cameraId,
                sourceType: msg.sourceType || 'web_stream',
                frameNumber: msg.frameNumber || 0,
                image,
                timestamp: msg.timestamp || Date.now(),
              },
            });
          }
          break;
        }

        case 'source_stop': {
          const cameraId = msg.cameraId || 'cam-01';
          cleanupStagedVideoForCamera(cameraId);
          wsManager.clearCameraPreview(cameraId);
          wsManager.unregisterWebSource(cameraId, ws);
          wsManager.clearPendingFrame(cameraId);
          wsManager.sendToInference(cameraId, {
            type: 'stop_source',
            cameraId,
          });
          break;
        }

        case 'request_camera_previews': {
          wsManager.requestAllCameraPreviews();
          break;
        }

        case 'set_source_loop': {
          const cameraId = msg.cameraId || 'cam-01';
          wsManager.sendToInference(cameraId, {
            type: 'set_source_loop',
            cameraId,
            loop: Boolean(msg.loop),
          });
          break;
        }

        case 'set_camera_bypass_zones': {
          const cameraId = msg.cameraId || 'cam-01';
          const bypass = Boolean(msg.bypass);
          wsManager.setCameraBypassZones(cameraId, bypass);
          wsManager.sendToInference(cameraId, {
            type: 'set_bypass_zones',
            cameraId,
            bypass,
          });
          wsManager.broadcastToClients({
            type: 'camera_bypass_zones_status',
            cameraId,
            bypass,
            timestamp: Date.now(),
          });
          break;
        }

        case 'switch_ai_source': {
          const cameraId = msg.cameraId || 'cam-01';
          const sType = msg.sourceType || 'server_video';
          wsManager.setInferenceMode(cameraId, sType === 'web_stream' ? 'ws' : 'local');
          wsManager.sendToInference(cameraId, {
            type: 'switch_source',
            cameraId,
            sourceType: sType,
            sourceValue: msg.sourceValue || 'test_1.mp4',
            loop: msg.loop ?? true,
          });
          break;
        }

        case 'switch_ai_model': {
          const profile = msg.profile === 'stock' ? 'stock' : 'trained';
          const sent = wsManager.sendModelSwitchToInference(profile);
          if (sent) {
            const pendingStatus = wsManager.setActiveModelStatus({ switching: true });
            wsManager.broadcastToClients({
              type: 'ai_model_status',
              ...pendingStatus,
              timestamp: Date.now(),
            });
          } else {
            ws.send(
              JSON.stringify({
                type: 'ai_model_status',
                ...wsManager.getActiveModelStatus(),
                switching: false,
                timestamp: Date.now(),
              })
            );
          }
          break;
        }

        case 'switch_ai_tracker': {
          const rawTracker = String(msg.tracker || 'bytetrack').toLowerCase();
          const tracker =
            rawTracker === 'botsort' || rawTracker === 'deepsort' ? rawTracker : 'bytetrack';
          const sent = wsManager.sendTrackerSwitchToInference(tracker);
          if (sent) {
            const pendingTracker = wsManager.setActiveTrackerStatus({ switching: true });
            wsManager.broadcastToClients({
              type: 'ai_tracker_status',
              ...pendingTracker,
              timestamp: Date.now(),
            });
          } else {
            ws.send(
              JSON.stringify({
                type: 'ai_tracker_status',
                ...wsManager.getActiveTrackerStatus(),
                switching: false,
                timestamp: Date.now(),
              })
            );
          }
          break;
        }

        default:
          break;
      }
    } catch {
      // Ignore malformed client messages
    }
  });

  ws.on('close', () => {
    wsManager.unregisterClient(ws);
  });

  ws.on('error', (err) => {
    console.error('[Client WS] Connection error:', err);
  });
}
