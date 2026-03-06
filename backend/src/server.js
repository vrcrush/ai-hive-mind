// server.js — Express backend for the AI Hive Mind
// Handles SSE streaming, session management, and hive orchestration

import express from 'express';
import cors from 'cors';
import { v4 as uuidv4 } from 'uuid';
import dotenv from 'dotenv';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { runHive, getSessionState } from './hiveOrchestrator.js';

// Load environment variables
// Try .env.local first (local dev), then fall back to .env (production)
dotenv.config({ path: '.env.local' });
dotenv.config(); // This won't override existing variables

const app = express();
const PORT = process.env.PORT || 3001;
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

// ── Security Middleware ────────────────────────────────────────────────────────

// Helmet - Security headers
app.use(helmet({
  contentSecurityPolicy: false, // Disable for SSE streaming
  crossOriginEmbedderPolicy: false
}));

// Rate limiting - Prevent abuse
const createLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: IS_PRODUCTION ? 20 : 100, // 10 requests per 15min in production, 100 in dev
  message: { 
    error: 'Too many requests. Please try again in 15 minutes.',
    retryAfter: 900 
  },
  standardHeaders: true,
  legacyHeaders: false,
});

const streamLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: IS_PRODUCTION ? 2 : 50, // 2 streams per minute in production
  message: { 
    error: 'Too many active sessions. Please wait before starting a new one.',
    retryAfter: 60 
  }
});

// Apply rate limiters
app.use('/api/session', createLimiter);
app.use('/api/hive', streamLimiter);

// ── CORS ───────────────────────────────────────────────────────────────────────

app.use(cors({
  origin: process.env.FRONTEND_URL || '*',
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'Accept']
}));

// ── Body Parser with Size Limit ────────────────────────────────────────────────

app.use(express.json({ 
  limit: '10kb' // Prevent large payload attacks
}));

// ── Input Validation Middleware ────────────────────────────────────────────────

function validateProblemInput(req, res, next) {
  const { problem } = req.body;
  
  if (!problem || typeof problem !== 'string') {
    return res.status(400).json({ error: 'Problem description is required' });
  }
  
  if (problem.trim().length < 10) {
    return res.status(400).json({ error: 'Problem must be at least 10 characters' });
  }
  
  if (problem.length > 5000) {
    return res.status(400).json({ error: 'Problem description too long (max 5000 characters)' });
  }
  
  // Basic XSS prevention
  const dangerousPatterns = /<script|javascript:|onerror=|onclick=/i;
  if (dangerousPatterns.test(problem)) {
    return res.status(400).json({ error: 'Invalid input detected' });
  }
  
  // Gibberish detection - prevent low-quality input
  const trimmed = problem.trim();
  
  // Check 1: All numbers (allows some numbers mixed with text)
  const numberRatio = (trimmed.match(/\d/g) || []).length / trimmed.length;
  if (numberRatio > 0.7) {
    return res.status(400).json({ error: 'Please enter a meaningful question, not just numbers' });
  }
  
  // Check 2: Repeated characters (e.g., "aaaaaaa", "1111111")
  const repeatedPattern = /(.)\1{5,}/;
  if (repeatedPattern.test(trimmed)) {
    return res.status(400).json({ error: 'Please enter a meaningful question without excessive repetition' });
  }
  
  // Check 3: Must contain at least one vowel (works for most languages)
  const hasVowel = /[aeiouáéíóúàèìòùäëïöüâêîôûAEIOUÁÉÍÓÚÀÈÌÒÙÄËÏÖÜÂÊÎÔÛ]/i.test(trimmed);
  if (!hasVowel) {
    return res.status(400).json({ error: 'Please enter a valid question with proper words' });
  }
  
  // Check 4: Must contain at least one space (ensures multi-word input)
  if (!trimmed.includes(' ')) {
    return res.status(400).json({ error: 'Please enter a complete question, not just one word' });
  }
  
  // Check 5: Keyboard smashing detection (e.g., "asdfghjkl", "qwertyuiop")
  const keyboardPatterns = [
    /qwertyuiop/i,
    /asdfghjkl/i,
    /zxcvbnm/i,
    /1234567890/,
    /0987654321/,
    /abcdefgh/i
  ];
  for (const pattern of keyboardPatterns) {
    if (pattern.test(trimmed)) {
      return res.status(400).json({ error: 'Please enter a meaningful question' });
    }
  }
  
  next();
}

function validateRounds(req, res, next) {
  const { rounds } = req.body;
  
  if (rounds && (typeof rounds !== 'number' || rounds < 1 || rounds > 1)) {
    return res.status(400).json({ error: 'Rounds must be 1 (locked to single round)' });
  }
  
  next();
}

// Active SSE connections: sessionId -> res
const activeConnections = new Map();

// Connection tracking for abuse prevention
const connectionTracker = new Map(); // IP -> { count, lastReset }

function trackConnection(ip) {
  const now = Date.now();
  const tracker = connectionTracker.get(ip) || { count: 0, lastReset: now };
  
  // Reset counter every hour
  if (now - tracker.lastReset > 3600000) {
    tracker.count = 0;
    tracker.lastReset = now;
  }
  
  tracker.count++;
  connectionTracker.set(ip, tracker);
  
  // Max 15 sessions per IP per hour in production
  if (IS_PRODUCTION && tracker.count > 15) {
    return false;
  }
  
  return true;
}

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
// GET /api/hive/:sessionId?problem=...&rounds=1
app.get('/api/hive/:sessionId', async (req, res) => {
  const { sessionId } = req.params;
  const { problem, rounds = 1 } = req.query;
  const clientIp = req.ip || req.connection.remoteAddress;

  // Validate session ID format
  if (!sessionId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId)) {
    return res.status(400).json({ error: 'Invalid session ID' });
  }

  // Check connection limits
  if (!trackConnection(clientIp)) {
    return res.status(429).json({ 
      error: 'Too many sessions from your IP. Please try again in 1 hour.' 
    });
  }

  // Validate problem
  if (!problem || typeof problem !== 'string' || problem.trim().length === 0) {
    return res.status(400).json({ error: 'Problem is required' });
  }

  if (problem.trim().length < 10) {
    return res.status(400).json({ error: 'Problem must be at least 10 characters' });
  }

  if (problem.length > 5000) {
    return res.status(400).json({ error: 'Problem too long (max 5000 characters)' });
  }

  // XSS prevention
  const dangerousPatterns = /<script|javascript:|onerror=|onclick=/i;
  if (dangerousPatterns.test(problem)) {
    return res.status(400).json({ error: 'Invalid input detected' });
  }

  // Gibberish detection - prevent low-quality input
  const trimmedProblem = problem.trim();
  
  // Check: All numbers (allows some numbers mixed with text)
  const numberRatio = (trimmedProblem.match(/\d/g) || []).length / trimmedProblem.length;
  if (numberRatio > 0.7) {
    return res.status(400).json({ error: 'Please enter a meaningful question, not just numbers' });
  }
  
  // Check: Repeated characters (e.g., "aaaaaaa", "1111111")
  const repeatedPattern = /(.)\1{5,}/;
  if (repeatedPattern.test(trimmedProblem)) {
    return res.status(400).json({ error: 'Please enter a meaningful question without excessive repetition' });
  }
  
  // Check: Must contain at least one vowel (works for most languages)
  const hasVowel = /[aeiouáéíóúàèìòùäëïöüâêîôûAEIOUÁÉÍÓÚÀÈÌÒÙÄËÏÖÜÂÊÎÔÛ]/i.test(trimmedProblem);
  if (!hasVowel) {
    return res.status(400).json({ error: 'Please enter a valid question with proper words' });
  }
  
  // Check: Must contain at least one space (ensures multi-word input)
  if (!trimmedProblem.includes(' ')) {
    return res.status(400).json({ error: 'Please enter a complete question, not just one word' });
  }
  
  // Check: Keyboard smashing detection
  const keyboardPatterns = [
    /qwertyuiop/i,
    /asdfghjkl/i,
    /zxcvbnm/i,
    /1234567890/,
    /0987654321/,
    /abcdefgh/i
  ];
  for (const pattern of keyboardPatterns) {
    if (pattern.test(trimmedProblem)) {
      return res.status(400).json({ error: 'Please enter a meaningful question' });
    }
  }

  // Validate rounds (locked to 1)
  const numRounds = parseInt(rounds, 10);
  if (isNaN(numRounds) || numRounds !== 1) {
    return res.status(400).json({ error: 'Rounds must be 1 (locked to single round)' });
  }

  // Check for existing active connection (prevent duplicate sessions)
  if (activeConnections.has(sessionId)) {
    return res.status(409).json({ error: 'Session already active' });
  }

  // Always use 1 round (locked)
  const roundCount = 1;

  // Security logging
  console.log(`[HIVE START] Session: ${sessionId}, IP: ${clientIp}, Problem length: ${problem.length}, Rounds: ${roundCount}`);

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
  ║      Mode: ${IS_PRODUCTION ? 'PRODUCTION' : 'DEVELOPMENT'}     ║
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
