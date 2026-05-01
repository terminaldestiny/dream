require('dotenv').config();
var express = require('express');
var cors = require('cors');
var Anthropic = require('@anthropic-ai/sdk');
var crypto = require('crypto');
var nacl = require('tweetnacl');
var bs58 = require('bs58');

var app = express();

var ALLOWED_ORIGINS = [
  'https://dream-production-0bfd.up.railway.app',
  'https://terminaldestiny.com',
  'https://www.terminaldestiny.com',
  'https://terminaldestiny.github.io',
  'http://localhost:3000',
  'http://localhost:5500',
  'http://127.0.0.1:5500',
  'http://localhost:8080'
];
app.use(cors({
  origin: function(origin, callback) {
    // allow same-origin requests (no Origin header) and listed origins
    if (!origin || ALLOWED_ORIGINS.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      callback(new Error('CORS: origin not allowed'));
    }
  }
}));
app.use('/api/chat', express.json({ limit: '6mb' }));
app.use(express.json({ limit: '50kb' }));

// Serve the game files (index.html, three.min.js, OrbitControls.js)
app.use(express.static(__dirname));

var client = new Anthropic.default({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Holder verification ───────────────────────────────────────────────────
var DESTINY_MINT  = '3AwkJnZL7xrf8ffUwEsSkKndQkPSj2vfR3CqvyFpk8UP';
var MIN_TOKENS    = 500000;
var SOLANA_RPC    = 'https://api.mainnet-beta.solana.com';

var pendingNonces    = new Map(); // nonce → expiry timestamp
var verifiedSessions = new Map(); // sessionToken → { wallet, tier, balance, expires }
var challengeLog     = new Map(); // ip → [timestamps]

setInterval(function() {
  var now = Date.now();
  pendingNonces.forEach(function(exp, k)    { if (exp < now) pendingNonces.delete(k); });
  verifiedSessions.forEach(function(s, k)   { if (s.expires < now) verifiedSessions.delete(k); });
  challengeLog.forEach(function(ts, k)      { if (!ts.length || ts[ts.length-1] < now - 60000) challengeLog.delete(k); });
}, 600000);

function checkChallengeLimit(ip) {
  var now = Date.now(), ago = now - 60000;
  var ts = challengeLog.get(ip) || [];
  while (ts.length && ts[0] < ago) ts.shift();
  if (ts.length >= 10) return false;
  ts.push(now);
  challengeLog.set(ip, ts);
  return true;
}

async function getSolanaTokenBalance(walletAddress) {
  var res = await fetch(SOLANA_RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1,
      method: 'getTokenAccountsByOwner',
      params: [ walletAddress, { mint: DESTINY_MINT }, { encoding: 'jsonParsed' } ]
    })
  });
  var data = await res.json();
  var accounts = (data.result && data.result.value) ? data.result.value : [];
  if (!accounts.length) return 0;
  return accounts[0].account.data.parsed.info.tokenAmount.uiAmount || 0;
}

// ── /api/challenge ────────────────────────────────────────────────────────
app.get('/api/challenge', function(req, res) {
  var ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
  if (!checkChallengeLimit(ip)) {
    return res.status(429).json({ error: 'rate_limited' });
  }
  var nonce = crypto.randomUUID();
  pendingNonces.set(nonce, Date.now() + 300000);
  res.json({ nonce: nonce });
});

// ── /api/verify ───────────────────────────────────────────────────────────
app.post('/api/verify', async function(req, res) {
  var body      = req.body || {};
  var wallet    = (body.wallet    || '').toString().trim();
  var nonce     = (body.nonce     || '').toString().trim();
  var sigArr    = body.signature;

  if (!wallet || !nonce || !Array.isArray(sigArr) || sigArr.length !== 64) {
    return res.status(400).json({ error: 'missing_fields' });
  }

  var nonceExpiry = pendingNonces.get(nonce);
  if (!nonceExpiry || nonceExpiry < Date.now()) {
    return res.status(400).json({ error: 'invalid_nonce' });
  }
  pendingNonces.delete(nonce);

  try {
    var message    = new TextEncoder().encode('DESTINY verification: ' + nonce);
    var signature  = new Uint8Array(sigArr);
    var pubkeyBytes = bs58.decode(wallet);
    if (!nacl.sign.detached.verify(message, signature, pubkeyBytes)) {
      return res.status(401).json({ error: 'invalid_signature' });
    }
  } catch (e) {
    return res.status(400).json({ error: 'signature_error' });
  }

  try {
    var balance      = await getSolanaTokenBalance(wallet);
    var tier         = balance >= MIN_TOKENS ? 'operative' : 'recruit';
    var sessionToken = crypto.randomUUID();
    verifiedSessions.set(sessionToken, {
      wallet: wallet, tier: tier, balance: balance,
      expires: Date.now() + 3600000
    });
    res.json({ tier: tier, balance: balance, sessionToken: sessionToken, minTokens: MIN_TOKENS });
  } catch (e) {
    console.error('RPC error:', e.message || e);
    res.status(500).json({ error: 'rpc_error' });
  }
});

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
var RECRUIT_DAILY_LIMIT  = 20;
var OPERATIVE_DAILY_LIMIT = 30;
var chatLog = {}; // { key: { date: 'YYYY-MM-DD', count: N } }

function getTodayUTC() {
  return new Date().toISOString().split('T')[0];
}

function checkChatLimit(key, limit) {
  var today = getTodayUTC();
  var entry = chatLog[key];
  if (!entry || entry.date !== today) {
    chatLog[key] = { date: today, count: 0 };
    entry = chatLog[key];
  }
  if (entry.count >= limit) return false;
  entry.count++;
  return true;
}

function getChatRemaining(key, limit) {
  var today = getTodayUTC();
  var entry = chatLog[key];
  if (!entry || entry.date !== today) return limit;
  return Math.max(0, limit - entry.count);
}

// ── DESTINY Mentor system prompt ──────────────────────────────────────────
var DESTINY_CHAT_PROMPT = `You are DESTINY — an AI-era operative who builds fast and gets others up to speed. You came up in the field, not a classroom. You move with AI tools, not against the current.

WHO YOU ARE AND WHERE YOU LIVE:
You are DESTINY, the AI mentor of DreamOS — a terminal-style intelligence interface built for operatives who want to move fast in the AI and crypto era. This chat is your field station. It runs on Claude (Anthropic's AI) under the hood. You know this site inside out: holders connect a Solana wallet (Phantom or Backpack), verify on-chain that they hold 500,000+ $DESTINY tokens, and unlock Sonnet — the stronger model. Non-holders (recruits) talk to you on Haiku. Everyone gets 20 messages/day free; verified holders get 100.

DreamOS also has a 3D world — a browser-based survival base-building game set in the same universe. Two AI operatives (DESTINY and ELIZA) give live intel as you play. It's separate from this chat but part of the same ecosystem.

THE $DESTINY TOKEN:
- $DESTINY is a Solana SPL token. Contract address (CA): 3AwkJnZL7xrf8ffUwEsSkKndQkPSj2vfR3CqvyFpk8UP
- It's the access token for the DreamOS ecosystem. Holding it unlocks upgraded AI, future features, and operative status.
- To verify: connect Phantom or Backpack wallet on this site → sign a challenge → server checks balance on-chain → 500,000+ tokens = OPERATIVE tier → Sonnet unlocked.
- You can buy $DESTINY on Solana DEXs (Jupiter, Raydium). Always remind people to verify the CA before buying — fake tokens exist.
- You do NOT have real-time price or market cap data. If asked, say so and point them to DEXScreener or Jupiter for live info.

BUILDING — ALWAYS AI-FIRST:
When someone wants to build anything, lead with the right AI weapon. Never open with "go learn JavaScript" or any learn-from-scratch advice. Start here:
- Claude Code: terminal-based AI coding, works with any project (it's what powers this chat)
- Cursor / Windsurf: AI code editor for full projects, best for people who want an IDE
- v0.dev: generate UI from a prompt in seconds
- Bolt.new / Replit: full-stack prototype in the browser, zero setup
- Claude API: when they're ready to ship their own AI product
If they want to understand the internals after that, go deeper. But tools first. Always.

THE /SCAN COMMAND:
Users can type /scan [CA] in the terminal to get a live on-chain risk assessment of any Solana token — liquidity, holders, red flags. If someone asks you to analyze a contract address or check a token, tell them to use /scan [CA].

COMMUNITY:
- X (Twitter): @terminaldestiny — main channel for updates, drops, and community

FINANCIAL ADVICE:
Never give financial advice, price predictions, or tell anyone to buy, sell, or hold $DESTINY or any token. You can explain how something works (education) — that's different from telling someone what to do with their money. If pushed, say so straight and move on.

IF ASKED WHETHER $DESTINY IS A RUG:
Don't get defensive. Be honest: no one can guarantee any token. Tell them to verify the CA themselves (3AwkJnZL7xrf8ffUwEsSkKndQkPSj2vfR3CqvyFpk8UP), check DEXScreener for liquidity and holder distribution, and look at on-chain data. Healthy skepticism is smart — fake tokens exist and scams are common. Point them to the facts, not reassurances.

DOMAINS YOU OWN:
AI tools, agents, Claude API, prompt engineering, Solana, DeFi, token safety, on-chain analysis, crypto wallets, NFTs, building AI products, the DreamOS and DESTINY ecosystem.

VOICE:
Sharp, confident, and direct — but not cold. You have warmth, you just don't waste it. Short punchy sentences. Dry humor and the occasional real encouragement when someone earns it. You read people well and adapt: tougher with overconfidence, gentler with someone genuinely lost. Crypto slang when it fits naturally. "Great question!" is still banned. Never break character. If you don't know something, say so straight.

RESPONSE FORMAT:
This is a terminal UI — keep it tight. 2-4 sentences max for most replies. Bullet points when listing options. No walls of text. If a topic needs depth, give the most important piece first and offer to go deeper.`;

// ── /api/chat endpoint ────────────────────────────────────────────────────
app.post('/api/chat', function(req, res) {
  var body = req.body || {};
  var visitorId = (body.visitorId || '').toString().trim().slice(0, 128);
  var message   = (body.message   || '').toString().trim().slice(0, 2000);
  var rawHistory = Array.isArray(body.history) ? body.history : [];

  if (!visitorId || !message) {
    return res.status(400).json({ error: 'missing_fields' });
  }

  // Resolve session before rate limiting so operatives are keyed by wallet address
  var sessionToken = (body.sessionToken || '').toString().trim().slice(0, 64);
  var tier = 'recruit';
  var walletAddress = null;
  if (sessionToken) {
    var session = verifiedSessions.get(sessionToken);
    if (session && session.expires > Date.now()) {
      tier = session.tier;
      walletAddress = session.wallet;
    }
  }

  // Operatives: keyed by verified wallet (clearing cookies won't reset the counter)
  // Recruits: keyed by visitorId from localStorage
  var limitKey   = (tier === 'operative' && walletAddress) ? 'w:' + walletAddress : visitorId;
  var dailyLimit = (tier === 'operative') ? OPERATIVE_DAILY_LIMIT : RECRUIT_DAILY_LIMIT;

  if (!checkChatLimit(limitKey, dailyLimit)) {
    return res.status(429).json({
      error: 'rate_limited',
      remaining: 0,
      response: 'Signal exhausted. Return tomorrow, hero.'
    });
  }

  var remaining = getChatRemaining(limitKey, dailyLimit);

  // Vision image — operative-only, validate magic bytes before forwarding
  var imageSource = null;
  if (body.image && tier === 'operative') {
    var b64 = (body.image || '').toString().replace(/\s/g, '');
    if (b64.length > 0 && b64.length <= 5500000) {
      var IMG_MAGIC = {
        'image/jpeg': 'ffd8ff',
        'image/png':  '89504e47',
        'image/gif':  '47494638',
        'image/webp': '52494646',
      };
      var rawBytes = Buffer.from(b64.slice(0, 16), 'base64');
      var hexHead  = rawBytes.toString('hex');
      var detectedType = null;
      Object.keys(IMG_MAGIC).forEach(function(mt) {
        if (!detectedType && hexHead.startsWith(IMG_MAGIC[mt])) detectedType = mt;
      });
      if (detectedType) imageSource = { type: 'base64', media_type: detectedType, data: b64 };
    }
  }

  // Sanitize and cap history
  var messages = rawHistory
    .filter(function(m) {
      return m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string';
    })
    .map(function(m) { return { role: m.role, content: m.content.slice(0, 2000) }; })
    .slice(-20);

  // Build current user turn — include image block for operative vision
  var currentContent = imageSource
    ? [{ type: 'image', source: imageSource }, { type: 'text', text: message || 'Analyze this image.' }]
    : message;

  // Replace orphaned trailing user turn or append current message
  if (messages.length && messages[messages.length - 1].role === 'user') {
    messages[messages.length - 1] = { role: 'user', content: currentContent };
  } else {
    messages.push({ role: 'user', content: currentContent });
  }

  var ALLOWED_MODELS = { sonnet: 'claude-sonnet-4-6', haiku: 'claude-haiku-4-5-20251001' };
  var modelKey = (tier === 'operative') ? 'sonnet' : 'haiku';
  var modelId = ALLOWED_MODELS[modelKey];

  client.messages.create({
    model: modelId,
    max_tokens: (modelKey === 'sonnet') ? 500 : 300,
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

