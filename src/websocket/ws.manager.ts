import { WebSocket } from 'ws';

export class WebSocketManager {
  private static instance: WebSocketManager;

  // Active AI inference connections by cameraId: Map<cameraId, WebSocket>
  private inferenceSockets: Map<string, WebSocket> = new Map();

  // Connected web frontend clients
  private clientSockets: Set<WebSocket> = new Set();

  // Pending on-demand clip requests: Map<requestId, { resolve, reject }>
  private pendingClipRequests: Map<
    string,
    { resolve: (data: string) => void; reject: (err: Error) => void }
  > = new Map();

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

  // --- On-Demand Evidence Fetching from ThunderCompute ---
  public requestClipFromInference(cameraId: string, filename: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const requestId = `req_${Date.now()}_${Math.random().toString(36).substring(7)}`;

      const timer = setTimeout(() => {
        this.pendingClipRequests.delete(requestId);
        reject(new Error(`Timeout waiting for video clip '${filename}' from camera '${cameraId}'.`));
      }, 30000);

      this.pendingClipRequests.set(requestId, {
        resolve: (data) => {
          clearTimeout(timer);
          resolve(data);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });

      const sent = this.sendToInference(cameraId, {
        type: 'fetch_clip_request',
        requestId,
        filename,
      });

      if (!sent) {
        clearTimeout(timer);
        this.pendingClipRequests.delete(requestId);
        reject(new Error(`Camera '${cameraId}' on ThunderCompute is currently offline.`));
      }
    });
  }

  public resolveClipRequest(requestId: string, data: string): void {
    const req = this.pendingClipRequests.get(requestId);
    if (req) {
      req.resolve(data);
      this.pendingClipRequests.delete(requestId);
    }
  }

  public rejectClipRequest(requestId: string, error: string): void {
    const req = this.pendingClipRequests.get(requestId);
    if (req) {
      req.reject(new Error(error));
      this.pendingClipRequests.delete(requestId);
    }
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
