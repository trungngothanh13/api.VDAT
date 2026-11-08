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

        case 'source_init': {
          const cameraId = msg.cameraId || 'cam-01';
          wsManager.registerWebSource(cameraId, ws);
          wsManager.setInferenceMode(cameraId, 'ws');

          if (wsManager.hasActiveInference(cameraId)) {
            console.log(
              `[Client WS] Web source (${msg.label || msg.sourceType}) initialized -> routing to connected AI Engine (${cameraId})`
            );
            wsManager.sendToInference(cameraId, {
              type: 'switch_source',
              cameraId,
              sourceType: 'web_stream',
              sourceValue: msg.label || msg.sourceType || 'web_stream',
              loop: true,
            });
          } else {
            console.warn(
              `[Client WS] Web source (${msg.label || msg.sourceType}) initialized for ${cameraId}, but NO Python AI Engine is connected to /ws/inference`
            );
          }

          await prisma.camera
            .upsert({
              where: { id: cameraId },
              update: {
                isActive: true,
                lastSeenAt: new Date(),
                metadata: {
                  sourceType: msg.sourceType || 'web_stream',
                  label: msg.label || 'Web Camera Stream',
                  fps: msg.fps || 30,
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
                metadata: {
                  sourceType: msg.sourceType || 'web_stream',
                  fps: msg.fps || 30,
                  width: msg.width || 854,
                  height: msg.height || 480,
                },
              },
            })
            .catch(() => {});
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
