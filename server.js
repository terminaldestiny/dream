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
