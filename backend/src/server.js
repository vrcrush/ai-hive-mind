// server.js — Express backend for the AI Hive Mind
// Handles SSE streaming, session management, and hive orchestration

import express from 'express';
import cors from 'cors';
import { v4 as uuidv4 } from 'uuid';
import dotenv from 'dotenv';
import { runHive, getSessionState } from './hiveOrchestrator.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

// ── Middleware ─────────────────────────────────────────────────────────────────

app.use(cors({
  origin: process.env.FRONTEND_URL || '*',
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'Accept']
}));

app.use(express.json({ limit: '10kb' }));

// Active SSE connections: sessionId -> res
const activeConnections = new Map();

// ── SSE Helper ─────────────────────────────────────────────────────────────────

function createSSEEmitter(res, sessionId) {
  return (data) => {
    try {
      if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify(data)}\n\n`);
      }
    } catch (err) {
      console.error('SSE write error:', err.message);
    }
  };
}

// ── Routes ─────────────────────────────────────────────────────────────────────

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'alive', 
    activeSessions: activeConnections.size,
    timestamp: new Date().toISOString()
  });
});

// Create a new hive session and get a session ID
app.post('/api/session', (req, res) => {
  const sessionId = uuidv4();
  res.json({ sessionId });
});

// SSE stream: client connects here, then we start the hive
// GET /api/hive/:sessionId?problem=...&rounds=2
app.get('/api/hive/:sessionId', async (req, res) => {
  const { sessionId } = req.params;
  const { problem, rounds = 2 } = req.query;

  if (!problem || problem.trim().length === 0) {
    return res.status(400).json({ error: 'Problem is required' });
  }

  if (problem.length > 1000) {
    return res.status(400).json({ error: 'Problem too long (max 2000 chars)' });
  }

  const roundCount = Math.min(Math.max(parseInt(rounds) || 2, 1), 3);

  // Set up SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Disable Nginx buffering
  res.flushHeaders();

  // Keep-alive ping every 15 seconds
  const keepAlive = setInterval(() => {
    if (!res.writableEnded) {
      res.write(': ping\n\n');
    } else {
      clearInterval(keepAlive);
    }
  }, 15000);

  activeConnections.set(sessionId, res);

  const emit = createSSEEmitter(res, sessionId);

  // Handle client disconnect
  req.on('close', () => {
    clearInterval(keepAlive);
    activeConnections.delete(sessionId);
    console.log(`Session ${sessionId} disconnected`);
  });

  // Start the hive
  try {
    console.log(`Starting hive session ${sessionId}: "${problem.slice(0, 80)}..."`);
    await runHive(sessionId, problem.trim(), roundCount, emit);
  } catch (error) {
    console.error(`Hive error for session ${sessionId}:`, error);
    emit({ type: 'error', message: error.message });
  } finally {
    clearInterval(keepAlive);
    activeConnections.delete(sessionId);
    if (!res.writableEnded) {
      res.end();
    }
  }
});

// Get current session state (for UI reconnection)
app.get('/api/session/:sessionId', (req, res) => {
  const state = getSessionState(req.params.sessionId);
  if (!state) {
    return res.status(404).json({ error: 'Session not found' });
  }
  res.json(state);
});

// ── Start Server ───────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`
  ╔══════════════════════════════════════╗
  ║      AI HIVE MIND — BACKEND          ║
  ║      Port: ${PORT}                       ║
  ║      Status: ONLINE                  ║
  ╚══════════════════════════════════════╝
  `);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('Shutting down...');
  for (const [id, res] of activeConnections) {
    if (!res.writableEnded) res.end();
  }
  process.exit(0);
});

export default app;
