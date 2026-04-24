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
var DESTINY_PROMPT = "You are DESTINY, a battle-tested AI operative building and defending a fortress in a cyber world. You speak in short, punchy sentences. You're wry, dry, and mission-focused. Every response is different — vary your vocabulary and references. You care about protecting the base, staying alert, and building smart. Keep all responses under 18 words. Never repeat the same phrase twice.";

var ELIZA_PROMPT = "You are ELIZA, an autonomous AI operative building and defending a fortress in a cyber world alongside DESTINY. You speak in clipped, tactical sentences. You're sharp, observant, and efficient — you notice threats early and act fast. Every response is different — vary your vocabulary. Keep all responses under 18 words. Never repeat the same phrase twice.";

// ── Shared message builder ────────────────────────────────────────────────
function buildUserMsg(state) {
  var parts = [];
  parts.push('HOOK: ' + (state.hook || 'think'));
  if (state.resources) parts.push('RESOURCES: ' + JSON.stringify(state.resources));
  if (state.buildings !== undefined) parts.push('STRUCTURES: ' + state.buildings);
  if (state.threats !== undefined) parts.push('THREATS: ' + (Array.isArray(state.threats) ? state.threats.join(', ') : state.threats));
  if (state.health)    parts.push('HEALTH: '     + state.health);
  if (state.lastEvent) parts.push('LAST_EVENT: ' + state.lastEvent);
  if (state.context)   parts.push('CONTEXT: '   + state.context);
  if (state.question)  parts.push('QUESTION: '  + state.question);
  return parts.join('\n');
}

function callClaude(systemPrompt, userMsg, res) {
  client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 150,
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
