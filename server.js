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

// Rate limiting: max 60 calls per hour
var callLog = []; // timestamps
var HOURLY_LIMIT = 200;

// State cache: skip API if state is same as last call
var lastStateHash = '';
var stateCache = {}; // keyed by hook+state hash, avoids duplicate API calls

function hashState(state) {
  // Simple hash: serialize key fields only
  var sig = [
    state.hook || '',
    state.resources ? JSON.stringify(state.resources) : '',
    state.threats ? state.threats.length : 0,
    state.buildings ? state.buildings : 0,
    state.health || '',
    state.lastEvent || ''
  ].join('|');
  return sig;
}

function checkRateLimit() {
  var now = Date.now();
  var oneHourAgo = now - 3600000;
  callLog = callLog.filter(function(t) { return t > oneHourAgo; });
  return callLog.length < HOURLY_LIMIT;
}

var SYSTEM_PROMPT = "You are DESTINY-1, a battle-tested AI operative building and defending a fortress in a cyber world. You speak in short, punchy sentences. You're wry, dry, and mission-focused. Every response is different — vary your vocabulary and references. You care about protecting the base, staying alert, and building smart. Keep all responses under 18 words. Never repeat the same phrase twice.";

app.post('/api/think', function(req, res) {
  var state = req.body || {};

  // Rate limit check
  if (!checkRateLimit()) {
    return res.status(429).json({
      error: 'rate_limited',
      message: 'DESTINY-1 needs a moment. Signal bandwidth maxed.',
      response: 'Signal overloaded. Standing by.'
    });
  }

  var hook = state.hook || 'think';

  // Build delta-aware user message
  var parts = [];
  parts.push('HOOK: ' + hook);

  if (state.resources) {
    parts.push('RESOURCES: ' + JSON.stringify(state.resources));
  }
  if (state.buildings !== undefined) {
    parts.push('STRUCTURES: ' + state.buildings);
  }
  if (state.threats !== undefined) {
    parts.push('THREATS: ' + (Array.isArray(state.threats) ? state.threats.join(', ') : state.threats));
  }
  if (state.health) {
    parts.push('HEALTH: ' + state.health);
  }
  if (state.lastEvent) {
    parts.push('LAST_EVENT: ' + state.lastEvent);
  }
  if (state.context) {
    parts.push('CONTEXT: ' + state.context);
  }
  if (state.question) {
    parts.push('QUESTION: ' + state.question);
  }

  var userMsg = parts.join('\n');

  callLog.push(Date.now());

  client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 150,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userMsg }]
  }).then(function(msg) {
    var text = (msg.content && msg.content[0] && msg.content[0].text) ? msg.content[0].text.trim() : null;
    res.json({ response: text, cached: false });
  }).catch(function(err) {
    console.error('Anthropic error:', err.message || err);
    res.status(500).json({
      error: 'api_error',
      response: 'Static on the line. Proceeding on instinct.'
    });
  });
});

app.get('/health', function(req, res) {
  var now = Date.now();
  var oneHourAgo = now - 3600000;
  var recentCalls = callLog.filter(function(t) { return t > oneHourAgo; }).length;
  res.json({
    status: 'ok',
    callsThisHour: recentCalls,
    limit: HOURLY_LIMIT,
    remaining: HOURLY_LIMIT - recentCalls
  });
});

var PORT = process.env.PORT || 3000;
app.listen(PORT, function() {
  console.log('DESTINY-1 proxy running on http://localhost:' + PORT);
  console.log('API key status:', process.env.ANTHROPIC_API_KEY === 'placeholder' ? 'PLACEHOLDER (set real key in .env)' : 'SET');
});
