import { WebSocket } from 'ws';
import { EventEmitter } from 'events';

export const evidenceEvents = new EventEmitter();
evidenceEvents.setMaxListeners(100);

export class WebSocketManager {
  private static instance: WebSocketManager;

  // Active AI inference connections by cameraId: Map<cameraId, WebSocket>
  private inferenceSockets: Map<string, WebSocket> = new Map();
  private inferenceModes: Map<string, string> = new Map();

  // Active web-fed camera transmitters (video file or laptop webcam): Map<cameraId, WebSocket>
  private webSourceSockets: Map<string, WebSocket> = new Map();

  // Connected web frontend clients
  private clientSockets: Set<WebSocket> = new Set();

  private constructor() {}

  public static getInstance(): WebSocketManager {
    if (!WebSocketManager.instance) {
      WebSocketManager.instance = new WebSocketManager();
    }
    return WebSocketManager.instance;
  }

  // --- Inference Sockets (Python AI Engine) ---
  public registerInference(cameraId: string, ws: WebSocket, ingestMode: string = 'local'): void {
    this.inferenceSockets.set(cameraId, ws);
    this.inferenceModes.set(cameraId, ingestMode);
    console.log(`[WS Manager] AI Inference connected for camera: ${cameraId} (mode: ${ingestMode})`);
    this.broadcastToClients({
      type: 'camera_status',
      cameraId,
      status: 'ONLINE',
      timestamp: Date.now(),
    });
  }

  public unregisterInference(cameraId: string): void {
    this.inferenceSockets.delete(cameraId);
    this.inferenceModes.delete(cameraId);
    console.log(`[WS Manager] AI Inference disconnected for camera: ${cameraId}`);
    if (!this.webSourceSockets.has(cameraId)) {
      this.broadcastToClients({
        type: 'camera_status',
        cameraId,
        status: 'OFFLINE',
        timestamp: Date.now(),
      });
    }
  }

  public isInferenceIngestingFromWeb(cameraId: string): boolean {
    const ws = this.inferenceSockets.get(cameraId);
    const mode = this.inferenceModes.get(cameraId);
    if (ws && ws.readyState === WebSocket.OPEN && mode === 'ws') {
      return true;
    }
    for (const [id, sock] of this.inferenceSockets.entries()) {
      if (sock.readyState === WebSocket.OPEN && this.inferenceModes.get(id) === 'ws') {
        return true;
      }
    }
    return false;
  }

  public setInferenceMode(cameraId: string, mode: string): void {
    if (this.inferenceSockets.has(cameraId)) {
      this.inferenceModes.set(cameraId, mode);
    } else {
      for (const id of this.inferenceSockets.keys()) {
        this.inferenceModes.set(id, mode);
      }
    }
  }

  public sendToInference(cameraId: string, payload: any): boolean {
    let ws = this.inferenceSockets.get(cameraId);
    if (!ws && this.inferenceSockets.size > 0) {
      ws = this.inferenceSockets.values().next().value;
    }
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(payload));
      return true;
    }
    return false;
  }

  // --- Web-Fed Camera Transmitters (Browser Video File / Laptop Webcam) ---
  public registerWebSource(cameraId: string, ws: WebSocket): void {
    this.webSourceSockets.set(cameraId, ws);
    console.log(`[WS Manager] Web-fed camera stream active for camera: ${cameraId}`);
    this.broadcastToClients({
      type: 'camera_status',
      cameraId,
      status: 'ONLINE',
      timestamp: Date.now(),
    });
  }

  public unregisterWebSource(cameraId: string, ws?: WebSocket): void {
    const current = this.webSourceSockets.get(cameraId);
    if (!ws || current === ws) {
      this.webSourceSockets.delete(cameraId);
      if (!this.inferenceSockets.has(cameraId)) {
        this.broadcastToClients({
          type: 'camera_status',
          cameraId,
          status: 'OFFLINE',
          timestamp: Date.now(),
        });
      }
    }
  }

  public unregisterAllWebSourcesForSocket(ws: WebSocket): void {
    for (const [camId, sock] of this.webSourceSockets.entries()) {
      if (sock === ws) {
        this.unregisterWebSource(camId, ws);
      }
    }
  }

  // --- Client Sockets (Web Dashboard) ---
  public registerClient(ws: WebSocket): void {
    this.clientSockets.add(ws);
    console.log(`[WS Manager] Web dashboard client connected (Total: ${this.clientSockets.size})`);
  }

  public unregisterClient(ws: WebSocket): void {
    this.clientSockets.delete(ws);
    this.unregisterAllWebSourcesForSocket(ws);
    console.log(
      `[WS Manager] Web dashboard client disconnected (Remaining: ${this.clientSockets.size})`
    );
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
    const active = new Set<string>([
      ...this.inferenceSockets.keys(),
      ...this.webSourceSockets.keys(),
    ]);
    return Array.from(active);
  }
}

export const wsManager = WebSocketManager.getInstance();
