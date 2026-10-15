import http from 'http';
import { WebSocketServer } from 'ws';

import { createApp } from './app.js';
import { config } from './config/env.js';
import { prisma } from './config/prisma.js';
import { handleInferenceConnection } from './websocket/inference.ws.js';
import { handleClientConnection } from './websocket/client.ws.js';

async function bootstrap() {
  const app = createApp();
  const server = http.createServer(app);

  // Initialize decoupled WebSocket Servers
  const wssInference = new WebSocketServer({ noServer: true });
  const wssClient = new WebSocketServer({ noServer: true });

  wssInference.on('connection', (ws) => {
    handleInferenceConnection(ws);
  });

  wssClient.on('connection', (ws) => {
    handleClientConnection(ws);
  });

  // Route WebSocket upgrade requests by URL path
  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url || '', `http://${request.headers.host || 'localhost'}`);
    const pathname = url.pathname;

    if (pathname === '/ws/inference' || pathname.startsWith('/ws/inference/')) {
      wssInference.handleUpgrade(request, socket, head, (ws) => {
        wssInference.emit('connection', ws, request);
      });
    } else if (pathname === '/ws/client' || pathname.startsWith('/ws/client/')) {
      wssClient.handleUpgrade(request, socket, head, (ws) => {
        wssClient.emit('connection', ws, request);
      });
    } else {
      socket.destroy();
    }
  });

  server.listen(config.port, () => {
    console.log('='.repeat(60));
    console.log(`🚀 api.VDAT Backend Server running on port ${config.port}`);
    console.log(`📡 Environment: ${config.nodeEnv}`);
    console.log(`🔗 REST API:    http://localhost:${config.port}/api`);
    console.log(`📑 Swagger UI:  http://localhost:${config.port}/docs`);
    console.log(`📥 AI Stream:   ws://localhost:${config.port}/ws/inference`);
    console.log(`📤 Web Stream:  ws://localhost:${config.port}/ws/client`);
    console.log('='.repeat(60));

  });

  const shutdown = async () => {
    console.log('\nGracefully shutting down api.VDAT...');
    wssInference.close();
    wssClient.close();
    server.close();
    await prisma.$disconnect();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

bootstrap().catch((err) => {
  console.error('Fatal bootstrap error:', err);
  process.exit(1);
});
