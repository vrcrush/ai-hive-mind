// hiveOrchestrator.js — Coordinates multi-agent thinking across the hive
// Manages turn order, parallel calls, memory injection, and relationship tracking
import 'dotenv/config'; // <--- Add this line at the top
import Anthropic from '@anthropic-ai/sdk';
import { AGENTS, AGENT_ORDER } from './agents.js';
import { memoryPool } from './memoryPool.js';

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY
});

// Detect if a response contains agreement or conflict signals
function detectRelationship(content, agentId, session) {
  const contentLower = content.toLowerCase();
  
  const agreementSignals = ['agree', 'correct', 'exactly', 'yes —', 'right —', 'builds on', 'confirms', 'validates'];
  const conflictSignals = ['however', 'but —', 'challenge', 'wrong', 'misses', 'fails', 'flawed', 'disagree', 'but this ignores', 'the flaw'];

  const hasAgreement = agreementSignals.some(sig => contentLower.includes(sig));
  const hasConflict = conflictSignals.some(sig => contentLower.includes(sig));

  if (hasAgreement) {
    // Find who they're agreeing with
    for (const thought of session.thoughts) {
      if (thought.agentId !== agentId) {
        if (contentLower.includes(thought.agentId) || contentLower.includes('the ' + AGENTS[thought.agentId]?.name?.toLowerCase().split(' ')[1])) {
          memoryPool.addAgreement(session.id, agentId, thought.agentId, 'Detected agreement signal');
          break;
        }
      }
    }
  }

  if (hasConflict) {
    // Find who they're conflicting with
    for (const thought of session.thoughts) {
      if (thought.agentId !== agentId) {
        if (contentLower.includes(thought.agentId) || contentLower.includes('the analyst') || contentLower.includes('the builder') || contentLower.includes('the empath')) {
          memoryPool.addConflict(session.id, agentId, thought.agentId, 'Detected conflict signal');
          break;
        }
      }
    }
  }

  return { hasAgreement, hasConflict };
}

// Call a single agent with full memory context, streaming to SSE
async function callAgent(sessionId, agentId, round, sseEmitter) {
  const agent = AGENTS[agentId];
  const session = memoryPool.getSession(sessionId);
  if (!session || !agent) return null;

  const memoryContext = memoryPool.getMemoryContext(sessionId, agentId);

  const userMessage = `${memoryContext}

Problem to address: ${session.problem}

Respond now as ${agent.name} (${agent.role}).`;

  let fullContent = '';
  
  try {
    // Signal this agent is starting
    sseEmitter({
      type: 'agent_start',
      agentId,
      agentName: agent.name,
      color: agent.color,
      round
    });

    // Stream the response token by token
    const stream = client.messages.stream({
      // model: 'claude-sonnet-4-5-20250929',
	  model: 'claude-haiku-4-5-20251001', // Using Claude Haiuku 4
	  max_tokens: 500,
      system: agent.systemPrompt,
      messages: [{ role: 'user', content: userMessage }]
    });

    for await (const chunk of stream) {
      if (chunk.type === 'content_block_delta' && chunk.delta?.type === 'text_delta') {
        const token = chunk.delta.text;
        fullContent += token;
        
        // Stream each token to the client
        sseEmitter({
          type: 'agent_token',
          agentId,
          token,
          round
        });
      }
    }

    // Record the complete thought in shared memory
    const thought = memoryPool.addThought(sessionId, agentId, fullContent, round);
    
    // Detect and record relationships
    const relationships = detectRelationship(fullContent, agentId, session);

    // Signal completion
    sseEmitter({
      type: 'agent_complete',
      agentId,
      content: fullContent,
      thoughtId: thought.id,
      round,
      ...relationships
    });

    return { agentId, content: fullContent, thought };

  } catch (error) {
    console.error(`Agent ${agentId} error:`, error.message);
    sseEmitter({
      type: 'agent_error',
      agentId,
      error: error.message,
      round
    });
    return null;
  }
}

// Run one full round: all 5 agents respond sequentially
// Sequential (not parallel) so each agent can read what the previous wrote
async function runRound(sessionId, round, sseEmitter) {
  sseEmitter({ type: 'round_start', round });

  const results = [];

  for (const agentId of AGENT_ORDER) {
    const result = await callAgent(sessionId, agentId, round, sseEmitter);
    if (result) {
      results.push(result);
    }
    
    // Brief pause between agents to allow UI updates
    await new Promise(r => setTimeout(r, 1000));
  }

  sseEmitter({ 
    type: 'round_complete', 
    round,
    stats: memoryPool.getStats(sessionId)
  });

  return results;
}

// Main orchestration: run the full hive on a problem
export async function runHive(sessionId, problem, rounds = 2, sseEmitter) {
  // Initialize session
  const session = memoryPool.createSession(sessionId);
  memoryPool.setProblem(sessionId, problem);

  sseEmitter({
    type: 'hive_start',
    sessionId,
    problem,
    rounds,
    agents: Object.keys(AGENTS).map(id => ({
      id,
      name: AGENTS[id].name,
      color: AGENTS[id].color,
      role: AGENTS[id].role
    }))
  });

  try {
    for (let r = 1; r <= rounds; r++) {
      memoryPool.nextRound(sessionId);
      await runRound(sessionId, r, sseEmitter);
    }

    memoryPool.completeSession(sessionId);
    
    const finalSession = memoryPool.getSession(sessionId);
    sseEmitter({
      type: 'hive_complete',
      sessionId,
      stats: memoryPool.getStats(sessionId),
      finalThoughts: finalSession.thoughts.length,
      agreements: finalSession.agreements,
      conflicts: finalSession.conflicts
    });

  } catch (error) {
    console.error('Hive orchestration error:', error);
    sseEmitter({
      type: 'hive_error',
      error: error.message
    });
  }
}

// Get current state of a session (for reconnecting clients)
export function getSessionState(sessionId) {
  return memoryPool.getSession(sessionId);
}
