import { WebSocket } from 'ws';

export class WebSocketManager {
  private static instance: WebSocketManager;

  // Active AI inference connections by cameraId: Map<cameraId, WebSocket>
  private inferenceSockets: Map<string, WebSocket> = new Map();

  // Connected web frontend clients
  private clientSockets: Set<WebSocket> = new Set();

  private constructor() {}

  public static getInstance(): WebSocketManager {
    if (!WebSocketManager.instance) {
      WebSocketManager.instance = new WebSocketManager();
    }
    return WebSocketManager.instance;
  }


  // --- Inference Sockets (ThunderCompute) ---
  public registerInference(cameraId: string, ws: WebSocket): void {
    this.inferenceSockets.set(cameraId, ws);
    console.log(`[WS Manager] AI Inference connected for camera: ${cameraId}`);
    this.broadcastToClients({
      type: 'camera_status',
      cameraId,
      status: 'ONLINE',
      timestamp: Date.now(),
    });
  }

  public unregisterInference(cameraId: string): void {
    this.inferenceSockets.delete(cameraId);
    console.log(`[WS Manager] AI Inference disconnected for camera: ${cameraId}`);
    this.broadcastToClients({
      type: 'camera_status',
      cameraId,
      status: 'OFFLINE',
      timestamp: Date.now(),
    });
  }

  public sendToInference(cameraId: string, payload: any): boolean {
    const ws = this.inferenceSockets.get(cameraId);
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(payload));
      return true;
    }
    return false;
  }


  // --- Client Sockets (Vercel / Web Dashboard) ---
  public registerClient(ws: WebSocket): void {
    this.clientSockets.add(ws);
    console.log(`[WS Manager] Web dashboard client connected (Total: ${this.clientSockets.size})`);
  }

  public unregisterClient(ws: WebSocket): void {
    this.clientSockets.delete(ws);
    console.log(`[WS Manager] Web dashboard client disconnected (Remaining: ${this.clientSockets.size})`);
  }

  public broadcastToClients(payload: any): void {
    const message = JSON.stringify(payload);
    for (const ws of this.clientSockets) {
      if (ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(message);
        } catch (err) {
          console.error('[WS Manager] Broadcast error to client:', err);
        }
      }
    }
  }

  public getActiveCameras(): string[] {
    return Array.from(this.inferenceSockets.keys());
  }
}

export const wsManager = WebSocketManager.getInstance();
