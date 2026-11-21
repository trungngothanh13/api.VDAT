import { WebSocket } from 'ws';
import { prisma } from '../config/prisma.js';
import { wsManager } from './ws.manager.js';

export function handleClientConnection(ws: WebSocket): void {
  wsManager.registerClient(ws);

  // Send initial handshake with active camera list
  ws.send(
    JSON.stringify({
      type: 'connection_established',
      activeCameras: wsManager.getActiveCameras(),
      timestamp: Date.now(),
    })
  );

  ws.on('message', async (data: Buffer | string) => {
    try {
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
            wsManager.sendToInference(cameraId, {
              type: 'ingest_frame',
              cameraId,
              sourceType: msg.sourceType || 'web_stream',
              frameNumber: msg.frameNumber || 0,
              image,
              timestamp: msg.timestamp || Date.now(),
            });
          }
          break;
        }

        case 'source_stop': {
          const cameraId = msg.cameraId || 'cam-01';
          wsManager.unregisterWebSource(cameraId, ws);
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
