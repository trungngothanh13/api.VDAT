import { WebSocket } from 'ws';
import { EventEmitter } from 'events';
import { encodeBinaryFrame } from './binary-frame.js';

export const evidenceEvents = new EventEmitter();
evidenceEvents.setMaxListeners(100);

// Sized for ~300ms international RTT (BDP: 15 FPS * 0.30s = 4.5 -> 8 frames keeps 15 FPS smooth with <180KB in flight)
const MAX_IN_FLIGHT_FRAMES = 8;
const IN_FLIGHT_STALE_MS = 2500;
const MAX_INFERENCE_BUFFERED_BYTES = 512 * 1024;
const MAX_CLIENT_BUFFERED_BYTES = 512 * 1024;

interface InferenceFlowState {
  nextSeq: number;
  ackedSeq: number;
  lastSentAt: number;
}

export interface QueuedInferenceFrame {
  header: Record<string, any>;
  payload?: Buffer;
}

export class WebSocketManager {
  private static instance: WebSocketManager;

  // Active AI inference connections by cameraId: Map<cameraId, WebSocket>
  private inferenceSockets: Map<string, WebSocket> = new Map();
  private inferenceModes: Map<string, string> = new Map();
  private inferenceFlow: Map<string, InferenceFlowState> = new Map();
  private latestPendingFrameByCamera: Map<string, QueuedInferenceFrame> = new Map();
  private inferenceSendImage: Map<string, boolean> = new Map();

  // Active web-fed camera transmitters (video file or laptop webcam): Map<cameraId, WebSocket>
  private webSourceSockets: Map<string, WebSocket> = new Map();

  // Connected web frontend clients and which camera each client currently focuses on in Main View
  private clientSockets: Set<WebSocket> = new Set();
  private clientFocusCamera: Map<WebSocket, string> = new Map();
  private latestFrameByCamera: Map<string, Buffer | string> = new Map();

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
    this.inferenceFlow.set(cameraId, { nextSeq: 0, ackedSeq: 0, lastSentAt: 0 });
    this.latestPendingFrameByCamera.delete(cameraId);
    this.inferenceSendImage.delete(cameraId);
    console.log(`[WS Manager] AI Inference connected for camera: ${cameraId} (mode: ${ingestMode})`);
    this.syncInferenceStreamFocus();
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
    this.inferenceFlow.delete(cameraId);
    this.latestPendingFrameByCamera.delete(cameraId);
    this.inferenceSendImage.delete(cameraId);
    this.latestFrameByCamera.delete(cameraId);
    console.log(`[WS Manager] AI Inference disconnected for camera: ${cameraId}`);
    this.broadcastToClients({
      type: 'camera_status',
      cameraId,
      status: 'OFFLINE',
      timestamp: Date.now(),
    });
  }

  public hasActiveInference(cameraId: string): boolean {
    const ws = this.inferenceSockets.get(cameraId);
    return Boolean(ws && ws.readyState === WebSocket.OPEN);
  }

  public isInferenceIngestingFromWeb(cameraId: string): boolean {
    const ws = this.inferenceSockets.get(cameraId);
    const mode = this.inferenceModes.get(cameraId);
    return Boolean(ws && ws.readyState === WebSocket.OPEN && mode === 'ws');
  }

  public setInferenceMode(cameraId: string, mode: string): void {
    if (this.inferenceSockets.has(cameraId)) {
      this.inferenceModes.set(cameraId, mode);
    }
  }

  public sendToInference(cameraId: string, payload: any): boolean {
    const ws = this.inferenceSockets.get(cameraId);
    if (ws && ws.readyState === WebSocket.OPEN) {
      if (payload?.type === 'ingest_frame' && ws.bufferedAmount > MAX_CLIENT_BUFFERED_BYTES) {
        return false;
      }
      ws.send(JSON.stringify(payload));
      return true;
    }
    return false;
  }

  private sendSequencedFrame(
    ws: WebSocket,
    flow: InferenceFlowState,
    frame: QueuedInferenceFrame
  ): boolean {
    const seq = flow.nextSeq + 1;
    const wireData: Buffer | string = frame.payload
      ? encodeBinaryFrame({ ...frame.header, seq }, frame.payload)
      : JSON.stringify({ ...frame.header, seq });
    try {
      ws.send(wireData);
      flow.nextSeq = seq;
      flow.lastSentAt = Date.now();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Monotonic sequence-number sliding window across SSH tunnels: allows at most
   * MAX_IN_FLIGHT_FRAMES unacknowledged frames per camera (BDP-matched for ~300ms RTT),
   * keeping only the newest pending frame instead of letting OpenSSH buffer megabytes.
   */
  public enqueueFrameForInference(cameraId: string, frame: QueuedInferenceFrame): boolean {
    const ws = this.inferenceSockets.get(cameraId);
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return false;
    }

    const now = Date.now();
    let flow = this.inferenceFlow.get(cameraId);
    if (!flow) {
      flow = { nextSeq: 0, ackedSeq: 0, lastSentAt: 0 };
      this.inferenceFlow.set(cameraId, flow);
    }

    let inFlight = flow.nextSeq - flow.ackedSeq;
    if (inFlight > 0 && now - flow.lastSentAt > IN_FLIGHT_STALE_MS) {
      flow.ackedSeq = flow.nextSeq;
      inFlight = 0;
    }

    if (inFlight < MAX_IN_FLIGHT_FRAMES && ws.bufferedAmount <= MAX_INFERENCE_BUFFERED_BYTES) {
      return this.sendSequencedFrame(ws, flow, frame);
    }

    // Tunnel/AI window is full for this camera: keep only the freshest pending frame
    this.latestPendingFrameByCamera.set(cameraId, frame);
    return false;
  }

  public ackInferenceFrame(cameraId: string, ackSeq?: number, ackedCount: number = 1): void {
    const ws = this.inferenceSockets.get(cameraId);
    let flow = this.inferenceFlow.get(cameraId);
    if (!flow) {
      flow = { nextSeq: 0, ackedSeq: 0, lastSentAt: 0 };
      this.inferenceFlow.set(cameraId, flow);
    }

    if (typeof ackSeq === 'number' && ackSeq > 0) {
      flow.ackedSeq = Math.min(flow.nextSeq, Math.max(flow.ackedSeq, ackSeq));
    } else {
      flow.ackedSeq = Math.min(flow.nextSeq, flow.ackedSeq + Math.max(1, ackedCount));
    }

    const pending = this.latestPendingFrameByCamera.get(cameraId);
    if (
      pending &&
      ws &&
      ws.readyState === WebSocket.OPEN &&
      flow.nextSeq - flow.ackedSeq < MAX_IN_FLIGHT_FRAMES &&
      ws.bufferedAmount <= MAX_INFERENCE_BUFFERED_BYTES
    ) {
      this.latestPendingFrameByCamera.delete(cameraId);
      this.sendSequencedFrame(ws, flow, pending);
    }
  }

  public clearPendingFrame(cameraId: string): void {
    this.latestPendingFrameByCamera.delete(cameraId);
    const flow = this.inferenceFlow.get(cameraId);
    if (flow) {
      flow.ackedSeq = flow.nextSeq;
    }
  }

  public syncInferenceStreamFocus(): void {
    const watchedCameras = new Set<string>();
    for (const camId of this.clientFocusCamera.values()) {
      watchedCameras.add(camId);
    }

    for (const [camId, sock] of this.inferenceSockets.entries()) {
      if (sock.readyState !== WebSocket.OPEN) continue;
      const shouldSendImage = watchedCameras.has(camId);
      if (this.inferenceSendImage.get(camId) !== shouldSendImage) {
        this.inferenceSendImage.set(camId, shouldSendImage);
        try {
          sock.send(
            JSON.stringify({
              type: 'set_stream_focus',
              cameraId: camId,
              sendImage: shouldSendImage,
            })
          );
        } catch {
          // Ignore send errors
        }
      }
    }
  }

  // --- Web-Fed Camera Transmitters (Browser Video File / Laptop Webcam) ---
  public registerWebSource(cameraId: string, ws: WebSocket): void {
    this.webSourceSockets.set(cameraId, ws);
    console.log(`[WS Manager] Web-fed camera transmitter active for camera: ${cameraId}`);
  }

  public unregisterWebSource(cameraId: string, ws?: WebSocket): void {
    const current = this.webSourceSockets.get(cameraId);
    if (!ws || current === ws) {
      this.webSourceSockets.delete(cameraId);
      this.clearPendingFrame(cameraId);
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
    this.clientFocusCamera.set(ws, 'cam-01');
    console.log(`[WS Manager] Web dashboard client connected (Total: ${this.clientSockets.size})`);
    this.syncInferenceStreamFocus();
  }

  public unregisterClient(ws: WebSocket): void {
    this.clientSockets.delete(ws);
    this.clientFocusCamera.delete(ws);
    this.unregisterAllWebSourcesForSocket(ws);
    this.syncInferenceStreamFocus();
    console.log(
      `[WS Manager] Web dashboard client disconnected (Remaining: ${this.clientSockets.size})`
    );
  }

  public setClientFocusCamera(ws: WebSocket, cameraId: string): void {
    this.clientFocusCamera.set(ws, cameraId);
    this.syncInferenceStreamFocus();
    const cached = this.latestFrameByCamera.get(cameraId);
    if (cached && ws.readyState === WebSocket.OPEN && ws.bufferedAmount <= MAX_CLIENT_BUFFERED_BYTES) {
      try {
        ws.send(cached);
      } catch {
        // Ignore send errors
      }
    }
  }

  public broadcastFrameToFocusedClients(
    cameraId: string,
    payload: Buffer | string | Record<string, any>
  ): void {
    const wireData: Buffer | string =
      Buffer.isBuffer(payload) || typeof payload === 'string'
        ? payload
        : JSON.stringify(payload);
    this.latestFrameByCamera.set(cameraId, wireData);

    for (const ws of this.clientSockets) {
      if (
        ws.readyState === WebSocket.OPEN &&
        (this.clientFocusCamera.get(ws) ?? 'cam-01') === cameraId &&
        ws.bufferedAmount <= MAX_CLIENT_BUFFERED_BYTES
      ) {
        try {
          ws.send(wireData);
        } catch (err) {
          console.error('[WS Manager] Frame send error to client:', err);
        }
      }
    }
  }

  public broadcastTelemetryToClients(cameraId: string, telemetry: any): void {
    this.broadcastToClients({
      type: 'camera_telemetry',
      cameraId,
      telemetry,
      timestamp: Date.now(),
    });
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
    const active: string[] = [];
    for (const [camId, sock] of this.inferenceSockets.entries()) {
      if (sock.readyState === WebSocket.OPEN) {
        active.push(camId);
      }
    }
    return active;
  }
}

export const wsManager = WebSocketManager.getInstance();
