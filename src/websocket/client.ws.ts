import { WebSocket } from 'ws';
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

  ws.on('message', (data: Buffer | string) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
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
