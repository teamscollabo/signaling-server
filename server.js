// server.js
const express = require('express');
const ws = require('ws');
const http = require('http');

const topics = new Map();
const PORT = process.env.PORT || 8787;

// --- Express app & HTTP server ---
const app = express();
app.set('trust proxy', 1); // Render/any proxy

// Basic health checks (Render can ping this)
app.get('/healthz', (_req, res) => res.status(200).type('text/plain').send('ok'));
app.get('/', (_req, res) => res.status(200).type('text/plain').send('Signaling server is running'));

const server = http.createServer(app);

// --- Optional: restrict WS to a path ---
const WS_PATH = process.env.WS_PATH || '/ws';

// --- Security: allowed origins for WS upgrades ---
const ALLOWED_ORIGINS = new Set([
  'https://collabo-r8vr1547i-collabo-teams-projects.vercel.app',
  'http://localhost:3000'
]);

// Pre-upgrade origin check (runs before ws accepts)
server.on('upgrade', (req, socket, head) => {
  try {
    // Only enforce origin checks when an Origin header is present (browsers).
    const origin = req.headers.origin;
    const url = new URL(req.url, 'http://x'); // base required but ignored for path compare

    if (url.pathname !== WS_PATH) {
      socket.destroy();
      return;
    }

    if (origin && !ALLOWED_ORIGINS.has(origin)) {
      socket.destroy();
      return;
    }

    // Hand off to ws server if checks pass
    wss.handleUpgrade(req, socket, head, (wsSocket) => {
      wss.emit('connection', wsSocket, req);
    });
  } catch {
    socket.destroy();
  }
});

// --- WebSocket server ---
const wss = new ws.Server({ noServer: true, clientTracking: true /* default */ });

const wsReadyStateOpen = 1;

const send = (conn, message) => {
  if (conn.readyState !== wsReadyStateOpen) {
    try { conn.close(); } catch {}
    return;
  }
  try {
    // Consider backpressure; skip if too backed up
    if (conn.bufferedAmount > 1_000_000) return; // ~1MB queued
    conn.send(JSON.stringify(message));
  } catch {
    try { conn.close(); } catch {}
  }
};

wss.on('connection', (socket, req) => {
  console.log(`WS connected from ${req.socket.remoteAddress} (origin: ${req.headers.origin || 'n/a'})`);
  socket.isAlive = true;

  const subscribedTopics = new Set();

  socket.on('error', (err) => console.error('WS error:', err?.message || err));

  socket.on('pong', () => { socket.isAlive = true; });

  socket.on('message', (data) => {
    let message;
    try {
      message = JSON.parse(data.toString());
    } catch {
      console.warn('Discarding non-JSON message');
      return;
    }

    switch (message?.type) {
      case 'subscribe': {
        const list = Array.isArray(message.topics) ? message.topics : [];
        // Defensive: cap number of topics per message to prevent abuse
        for (const topicName of list.slice(0, 64)) {
          if (typeof topicName !== 'string' || !topicName) continue;
          let subscribers = topics.get(topicName);
          if (!subscribers) {
            subscribers = new Set();
            topics.set(topicName, subscribers);
          }
          subscribers.add(socket);
          subscribedTopics.add(topicName);
          console.log(`Join room "${topicName}" :: ${subscribers.size} clients`);
        }
        break;
      }

      case 'publish': {
        const t = message.topic;
        if (typeof t === 'string' && t) {
          const receivers = topics.get(t);
          if (receivers) {
            receivers.forEach((receiver) => {
              if (receiver !== socket) send(receiver, message);
            });
          }
        }
        break;
      }

      case 'unsubscribe': {
        const list = Array.isArray(message.topics) ? message.topics : [];
        for (const topicName of list) {
          const subscribers = topics.get(topicName);
          if (subscribers) {
            subscribers.delete(socket);
            subscribedTopics.delete(topicName);
            if (subscribers.size === 0) topics.delete(topicName);
          }
        }
        break;
      }

      case 'ping': {
        send(socket, { type: 'pong' });
        break;
      }

      default:
        console.log(`Unhandled message type: ${message?.type}`);
    }
  });

  socket.on('close', () => {
    // Remove from all subscribed topics
    subscribedTopics.forEach((topicName) => {
      const subscribers = topics.get(topicName);
      if (subscribers) {
        subscribers.delete(socket);
        console.log(`Left room "${topicName}" :: remaining ${subscribers.size}`);
        if (subscribers.size === 0) topics.delete(topicName);
      }
    });
    subscribedTopics.clear();
  });
});

// Heartbeat (keep-alive & dead-peer cleanup)
const checkAliveInterval = setInterval(() => {
  wss.clients.forEach((socket) => {
    if (socket.isAlive === false) {
      return socket.terminate();
    }
    socket.isAlive = false;
    try { socket.ping(); } catch { socket.terminate(); }
  });
}, 30_000);

// Start
server.listen(PORT, '0.0.0.0', () => {
  console.log(`HTTP+WS listening on ${PORT} (path: ${WS_PATH})`);
});

// Graceful shutdown (Render sends SIGTERM on redeploy)
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down...');
  clearInterval(checkAliveInterval);
  server.close(() => {
    // Close all WS clients
    wss.clients.forEach(c => { try { c.close(); } catch {} });
    console.log('Closed gracefully');
    process.exit(0);
  });
});
