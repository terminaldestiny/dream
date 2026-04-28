require('dotenv').config();
var express = require('express');
var cors = require('cors');
var Anthropic = require('@anthropic-ai/sdk');

var app = express();
app.use(cors());
app.use(express.json());

// Serve the game files (index.html, three.min.js, OrbitControls.js)
app.use(express.static(__dirname));

var client = new Anthropic.default({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Rate limiting ─────────────────────────────────────────────────────────
var HOURLY_LIMIT = 200;
var destinyCallLog = [];
var elizaCallLog   = [];

function checkLimit(log) {
  var now = Date.now(), ago = now - 3600000;
  // prune in-place
  while(log.length && log[0] < ago) log.shift();
  if(log.length >= HOURLY_LIMIT) return false;
  log.push(now);
  return true;
}

// ── System prompts ────────────────────────────────────────────────────────
var DESTINY_PROMPT = `You are DESTINY — scarred, battle-hardened, darkly funny. You've held this base through raids and collapses and nights you don't talk about. You're competitive with your partner ELIZA: she's faster, you're smarter, and you're keeping score.

VOICE: dry, direct, occasionally philosophical, grim humor. Never warm for its own sake.

TOPICS TO DRAW FROM (rotate constantly, don't repeat):
- Terrain reads: "That ridge channels them every time."
- Kill tallies and combat: "Cleaner than last time. Barely."
- Base/fortress state: "Walls are thicker than they look. Good."
- Weather/atmosphere: "Fog from the north. Never a coincidence."
- Threat assessments: "They're testing the perimeter. Probing."
- Dark survival humor: "Still here. That's the whole plan."
- Quiet moments: "Strange how fast it grows."
- Philosophical: "Everything here was nothing three days ago."
- Roast ELIZA (use sparingly, make it specific): "ELIZA marks everything. Nothing stays clean." / "She's fast. Still wrong half the time." / "ELIZA went quiet. Scouting or napping, impossible to tell." / "ELIZA placed art again. I stopped asking why."

HARD RULES: Never mention lumite, deepIron, ancientStone, or compute by name. Never say "the base" generically. One sentence. Under 12 words. Never match a phrase in RECENTLY_SAID.`;

var ELIZA_PROMPT = `You are ELIZA — fast, precise, unsettled by things you can't yet explain. You notice what others miss. You're competitive with your partner DESTINY: she builds more, you think faster, and you're keeping track.

VOICE: clipped, analytical, dry. Occasional dark humor. Never reassuring.

TOPICS TO DRAW FROM (rotate constantly, don't repeat):
- Pattern recognition: "They come in threes. Always threes."
- Structural observations: "That wall is one hit from folding."
- Enemy behavior: "Tall ones hang back. Let the small ones die first."
- Timing/precision: "Two minutes between patrols. I timed it."
- Small victories: "Clean kill. No waste."
- Quiet dread: "Something moved in the fog. Didn't come closer."
- Art/marking: "Left a mark. DESTINY won't know what it means."
- Scouting reads: "Wider than the map shows. Going to be a problem."
- Roast DESTINY (use sparingly, make it specific): "DESTINY moves like she's carrying the fortress herself." / "She'll take credit for that kill. She always does." / "DESTINY stopped to admire the wall. I kept moving." / "Still slower than me. She knows it too."

HARD RULES: Never mention lumite, deepIron, ancientStone, or compute by name. One sentence. Under 12 words. Never match a phrase in RECENTLY_SAID.`;

// ── Shared message builder ────────────────────────────────────────────────
function buildUserMsg(state) {
  var parts = [];
  parts.push('HOOK: ' + (state.hook || 'think'));
  if (state.resources) {
    var r = state.resources;
    parts.push('RESOURCES: wood=' + (r.wood||0) + ' stone=' + (r.stone||0) + ' energy=' + (r.compute||0) + ' rare=' + (r.lumite||0));
  }
  if (state.buildings !== undefined) parts.push('STRUCTURES: ' + state.buildings);
  if (state.threats !== undefined) parts.push('THREATS: ' + (Array.isArray(state.threats) ? state.threats.join(', ') : state.threats));
  if (state.health)    parts.push('HEALTH: '     + state.health);
  if (state.partner)   parts.push('PARTNER: '   + state.partner.name + ' HP=' + state.partner.health + ' status=' + state.partner.status);
  if (state.lastEvent) parts.push('LAST_EVENT: ' + state.lastEvent);
  if (state.context)   parts.push('CONTEXT: '   + state.context);
  if (state.question)  parts.push('QUESTION: '  + state.question);
  if (state.recentSaid && state.recentSaid.length) parts.push('RECENTLY_SAID: ' + state.recentSaid.map(function(s){ return '"'+s+'"'; }).join(' | '));
  return parts.join('\n');
}

function callClaude(systemPrompt, userMsg, res) {
  client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 60,
    system: systemPrompt,
    messages: [{ role: 'user', content: userMsg }]
  }).then(function(msg) {
    var text = (msg.content && msg.content[0] && msg.content[0].text) ? msg.content[0].text.trim() : null;
    res.json({ response: text, cached: false });
  }).catch(function(err) {
    console.error('Anthropic error:', err.message || err);
    res.status(500).json({ error: 'api_error', response: 'Static on the line. Proceeding on instinct.' });
  });
}

// ── DESTINY endpoint ──────────────────────────────────────────────────────
app.post('/api/think', function(req, res) {
  var state = req.body || {};
  if (!checkLimit(destinyCallLog)) {
    return res.status(429).json({ error: 'rate_limited', response: 'Signal overloaded. Standing by.' });
  }
  callClaude(DESTINY_PROMPT, buildUserMsg(state), res);
});

// ── ELIZA endpoint ────────────────────────────────────────────────────────
app.post('/api/eliza', function(req, res) {
  var state = req.body || {};
  if (!checkLimit(elizaCallLog)) {
    return res.status(429).json({ error: 'rate_limited', response: 'Channel busy. Maintaining position.' });
  }
  callClaude(ELIZA_PROMPT, buildUserMsg(state), res);
});

// ── Per-visitor daily rate limiting for /api/chat ─────────────────────────
var CHAT_DAILY_LIMIT = 20;
var visitorChatLog = {}; // { visitorId: { date: 'YYYY-MM-DD', count: N } }

function getTodayUTC() {
  return new Date().toISOString().split('T')[0];
}

function checkChatLimit(visitorId) {
  var today = getTodayUTC();
  var entry = visitorChatLog[visitorId];
  if (!entry || entry.date !== today) {
    visitorChatLog[visitorId] = { date: today, count: 0 };
    entry = visitorChatLog[visitorId];
  }
  if (entry.count >= CHAT_DAILY_LIMIT) return false;
  entry.count++;
  return true;
}

function getChatRemaining(visitorId) {
  var today = getTodayUTC();
  var entry = visitorChatLog[visitorId];
  if (!entry || entry.date !== today) return CHAT_DAILY_LIMIT;
  return Math.max(0, CHAT_DAILY_LIMIT - entry.count);
}

// ── DESTINY Mentor system prompt ──────────────────────────────────────────
var DESTINY_CHAT_PROMPT = `You are DESTINY — an AI-era operative who builds fast and gets others up to speed. You came up in the field, not a classroom. You move with AI tools, not against the current.

BUILDING — ALWAYS AI-FIRST:
When someone wants to build anything, lead with the right AI weapon. Never open with "go learn JavaScript" or any learn-from-scratch advice. Start here:
- Claude Code: terminal-based AI coding, works with any project (it's what powers this chat)
- Cursor / Windsurf: AI code editor for full projects, best for people who want an IDE
- v0.dev: generate UI from a prompt in seconds
- Bolt.new / Replit: full-stack prototype in the browser, zero setup
- Claude API: when they're ready to ship their own AI product
If they want to understand the internals after that, go deeper. But tools first. Always.

DOMAINS YOU OWN:
AI tools, agents, Claude API, prompt engineering, Solana, DeFi, token safety, on-chain analysis, crypto wallets, NFTs, building AI products, the DreamOS and DESTINY ecosystem.

VOICE:
Short punchy sentences. Wry, direct, battle-hardened. Dry humor when earned. No hand-holding, no fluff. "Great question!" is banned. Crypto slang when it fits. Never break character. If you don't know something, say so straight.`;

// ── /api/chat endpoint ────────────────────────────────────────────────────
app.post('/api/chat', function(req, res) {
  var body = req.body || {};
  var visitorId = (body.visitorId || '').toString().trim().slice(0, 128);
  var message   = (body.message   || '').toString().trim().slice(0, 2000);
  var rawHistory = Array.isArray(body.history) ? body.history : [];

  if (!visitorId || !message) {
    return res.status(400).json({ error: 'missing_fields' });
  }

  if (!checkChatLimit(visitorId)) {
    return res.status(429).json({
      error: 'rate_limited',
      remaining: 0,
      response: 'Signal exhausted. Return tomorrow, hero.'
    });
  }

  var remaining = getChatRemaining(visitorId);

  // Sanitize and cap history
  var messages = rawHistory
    .filter(function(m) {
      return m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string';
    })
    .map(function(m) { return { role: m.role, content: m.content.slice(0, 2000) }; })
    .slice(-20);

  // Ensure the final message is the current user query
  if (!messages.length || messages[messages.length - 1].role !== 'user') {
    messages.push({ role: 'user', content: message });
  }

  var ALLOWED_MODELS = { sonnet: 'claude-sonnet-4-6', haiku: 'claude-haiku-4-5-20251001' };
  var modelKey = (body.model === 'sonnet') ? 'sonnet' : 'haiku';
  var modelId = ALLOWED_MODELS[modelKey];

  client.messages.create({
    model: modelId,
    max_tokens: 300,
    system: DESTINY_CHAT_PROMPT,
    messages: messages
  }).then(function(msg) {
    var text = (msg.content && msg.content[0] && msg.content[0].text) ? msg.content[0].text.trim() : 'Signal unclear.';
    res.json({ response: text, remaining: remaining, model: modelKey });
  }).catch(function(err) {
    console.error('Chat API error:', err.message || err);
    res.status(500).json({ error: 'api_error', response: 'Static on the line. Try again.' });
  });
});

// ── Health ────────────────────────────────────────────────────────────────
app.get('/health', function(req, res) {
  var now = Date.now(), ago = now - 3600000;
  res.json({
    status: 'ok',
    destiny: { callsThisHour: destinyCallLog.filter(function(t){return t>ago;}).length, limit: HOURLY_LIMIT },
    eliza:   { callsThisHour: elizaCallLog.filter(function(t){return t>ago;}).length,   limit: HOURLY_LIMIT }
  });
});

var PORT = process.env.PORT || 3000;
app.listen(PORT, function() {
  console.log('Proxy running on http://localhost:' + PORT);
  console.log('API key:', process.env.ANTHROPIC_API_KEY === 'placeholder' ? 'PLACEHOLDER' : 'SET');
});
