// memoryPool.js — The shared consciousness of the Hive Mind
// All agents read from and write to this pool before/after each turn

import { v4 as uuidv4 } from 'uuid';

class MemoryPool {
  constructor() {
    // Map of sessionId -> session memory
    this.sessions = new Map();
  }

  // Initialize a new session
  createSession(sessionId) {
    this.sessions.set(sessionId, {
      id: sessionId,
      createdAt: Date.now(),
      problem: null,
      thoughts: [],          // All agent thoughts in order
      agreements: [],        // Tracked agreements between agents
      conflicts: [],         // Tracked conflicts between agents
      round: 0,
      status: 'idle'
    });
    return this.sessions.get(sessionId);
  }

  getSession(sessionId) {
    return this.sessions.get(sessionId);
  }

  // Set the initial problem for a session
  setProblem(sessionId, problem) {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    session.problem = problem;
    session.status = 'thinking';
    return session;
  }

  // Record a thought from an agent
  addThought(sessionId, agentId, content, round) {
    const session = this.sessions.get(sessionId);
    if (!session) return null;

    const thought = {
      id: uuidv4(),
      agentId,
      content,
      round,
      timestamp: Date.now(),
      reactions: []  // Other agents can react
    };

    session.thoughts.push(thought);
    return thought;
  }

  // Record an agreement between two agents
  addAgreement(sessionId, fromAgentId, toAgentId, reason) {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    session.agreements.push({
      from: fromAgentId,
      to: toAgentId,
      reason,
      timestamp: Date.now()
    });
  }

  // Record a conflict between two agents
  addConflict(sessionId, fromAgentId, toAgentId, reason) {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    session.conflicts.push({
      from: fromAgentId,
      to: toAgentId,
      reason,
      timestamp: Date.now()
    });
  }

  // Get the full memory context to inject into agent prompts
  // Each agent sees everything the others have thought
  getMemoryContext(sessionId, currentAgentId) {
    const session = this.sessions.get(sessionId);
    if (!session || session.thoughts.length === 0) {
      return 'No prior thinking in the hive yet. You are first.';
    }

    const lines = ['=== HIVE MIND SHARED MEMORY ==='];
    lines.push(`Problem: ${session.problem}`);
    lines.push(`Round: ${session.round}`);
    lines.push('');
    lines.push('What the other nodes have thought:');
    lines.push('');

    session.thoughts.forEach(t => {
      if (t.agentId !== currentAgentId) {
        lines.push(`[${t.agentId.toUpperCase()}]: ${t.content}`);
        lines.push('');
      }
    });

    // Include relationships
    if (session.agreements.length > 0) {
      lines.push('--- ESTABLISHED AGREEMENTS ---');
      session.agreements.forEach(a => {
        lines.push(`${a.from} agreed with ${a.to}: ${a.reason}`);
      });
      lines.push('');
    }

    if (session.conflicts.length > 0) {
      lines.push('--- ACTIVE CONFLICTS ---');
      session.conflicts.forEach(c => {
        lines.push(`${c.from} conflicts with ${c.to}: ${c.reason}`);
      });
      lines.push('');
    }

    lines.push('=== END SHARED MEMORY ===');
    lines.push('');
    lines.push(`Now respond as ${currentAgentId.toUpperCase()} to the problem AND to what you have read above.`);

    return lines.join('\n');
  }

  // Get recent thoughts for SSE streaming (only new ones after a cursor)
  getThoughtsSince(sessionId, afterTimestamp) {
    const session = this.sessions.get(sessionId);
    if (!session) return [];
    return session.thoughts.filter(t => t.timestamp > afterTimestamp);
  }

  // Mark session complete
  completeSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (session) session.status = 'complete';
  }

  // Increment round
  nextRound(sessionId) {
    const session = this.sessions.get(sessionId);
    if (session) session.round++;
    return session?.round;
  }

  // Cleanup old sessions (>2 hours)
  cleanup() {
    const cutoff = Date.now() - 2 * 60 * 60 * 1000;
    for (const [id, session] of this.sessions.entries()) {
      if (session.createdAt < cutoff) {
        this.sessions.delete(id);
      }
    }
  }

  // Get summary stats for a session
  getStats(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    return {
      thoughtCount: session.thoughts.length,
      agreements: session.agreements.length,
      conflicts: session.conflicts.length,
      round: session.round,
      status: session.status
    };
  }
}

// Singleton pool shared across all sessions
export const memoryPool = new MemoryPool();

// Cleanup every 30 minutes
setInterval(() => memoryPool.cleanup(), 30 * 60 * 1000);
