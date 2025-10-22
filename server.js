const express = require('express');
const ws = require('ws');
const http = require('http');

/** @type {Map<string, Set<ws>>} */
const topics = new Map();

/** @type {number} */
const PORT = process.env.PORT || 8787;

// Create an Express app and an HTTP server instance
const app = express();
const server = http.createServer(app);

// Simple HTTP handler for health check
app.get('/', (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Signaling server is running');
});

// Create the WebSocket Server using the HTTP server
const wss = new ws.Server({ server });

const wsReadyStateOpen = 1;

/**
 * Sends a JSON message to a connection, handling closed connections.
 * @param {ws} conn
 * @param {object} message
 */
const send = (conn, message) => {
    if (conn.readyState !== wsReadyStateOpen) {
        conn.close();
        return;
    }
    try {
        // Send the raw message (already in JSON format from 'publish' or 'ping')
        conn.send(JSON.stringify(message));
    } catch (e) {
        conn.close();
    }
}

wss.on('connection', (socket, req) => {
    console.log(`Client connected from: ${req.socket.remoteAddress}`);

    socket.isAlive = true;
    
    /** @type {Set<string>} */
    const subscribedTopics = new Set();

    socket.on('error', console.error);

    socket.on('pong', () => {
        socket.isAlive = true;
    });

    socket.on('message', (data) => {
        let message;
        try {
            // All y-webrtc signaling messages are JSON
            message = JSON.parse(data.toString());
        } catch (e) {
            console.warn('Received invalid non-JSON message. Discarding.');
            return;
        }

        if (message && message.type) {
            switch (message.type) {
                case 'subscribe':
                    /** @type {Array<string>} */ 
                    (message.topics || []).forEach(topicName => {
                        if (typeof topicName === 'string') {
                            // Add connection to topic Set
                            const subscribers = topics.get(topicName) || new Set();
                            subscribers.add(socket);
                            topics.set(topicName, subscribers);

                            // Add topic to connection's set for cleanup
                            subscribedTopics.add(topicName);
                            console.log(`Client joined room: ${topicName}. Total clients in room: ${subscribers.size}`);
                        }
                    });
                    break;

                case 'publish':
                    if (message.topic) {
                        const receivers = topics.get(message.topic);

                        if (receivers) {
                            // Relay the message to all other clients in the room
                            receivers.forEach(receiver => {
                                if (socket !== receiver) {
                                    // Send the message object directly (will be stringified by send function)
                                    send(receiver, message);
                                }
                            });
                        }
                    }
                    break;

                case 'unsubscribe':
                    /** @type {Array<string>} */ 
                    (message.topics || []).forEach(topicName => {
                        const subscribers = topics.get(topicName);
                        if (subscribers) {
                            subscribers.delete(socket);
                        }
                    });
                    break;

                case 'ping':
                    // Client pings the server (uncommon, but handled)
                    send(socket, { type: 'pong' });
                    break;

                default:
                    console.log(`Unhandled message type: ${message.type}`);
                    break;
            }
        }
    });

    socket.on('close', () => {
        console.log('Client disconnected.');
        
        // Remove client from all subscribed topics
        subscribedTopics.forEach(topicName => {
            const subscribers = topics.get(topicName);
            if (subscribers) {
                subscribers.delete(socket);
                console.log(`Client left room: ${topicName}. Remaining: ${subscribers.size}`);
                if (subscribers.size === 0) {
                    topics.delete(topicName); // Clean up empty rooms
                }
            }
        });
        subscribedTopics.clear();
    });
});

// PING/PONG heartbeating for keeping connections alive
const checkAliveInterval = setInterval(() => {
    wss.clients.forEach(socket => {
        if (socket.isAlive === false) {
            return socket.terminate();
        }
        socket.isAlive = false;
        try {
            socket.ping();
        } catch (e) {
            // Error on ping, close connection
            socket.terminate();
        }
    });
}, 30000);

server.listen(PORT, () => console.log(`Listening on ${PORT}`));