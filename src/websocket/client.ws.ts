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

          // If an AI Engine is connected, instruct it to switch to web-stream ingestion mode
          wsManager.sendToInference(cameraId, {
            type: 'switch_source',
            cameraId,
            sourceType: 'web_stream',
            sourceValue: msg.label || msg.sourceType || 'web_stream',
            loop: true,
          });

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

          // If Python AI Engine is connected in 'ws' ingestion mode, feed the frame into AI inference
          if (wsManager.isInferenceIngestingFromWeb(cameraId)) {
            wsManager.sendToInference(cameraId, {
              type: 'ingest_frame',
              cameraId,
              image,
              timestamp: msg.timestamp || Date.now(),
            });
          } else {
            // Standalone camera stream mode: relay directly to all connected monitoring clients
            wsManager.broadcastToClients({
              type: 'live_frame',
              cameraId,
              telemetry: msg.telemetry || {
                frame_number: msg.frameNumber || 0,
                timestamp: msg.timestamp || Date.now() / 1000,
                fps: msg.fps || 20,
                vehicle_count: 0,
                total_tracked: 0,
                light_state: 'unknown',
                violations_count: 0,
              },
              image,
              timestamp: Date.now(),
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
