/**
 * generate-enemy.js
 * Calls Meshy AI text-to-3D API, polls until done, downloads GLB to assets/
 *
 * Usage:  node generate-enemy.js
 * Needs:  MESHY_API_KEY in .env
 */

require('dotenv').config();
var https = require('https');
var http  = require('http');
var fs    = require('fs');
var path  = require('path');
var url   = require('url');

var API_KEY = process.env.MESHY_API_KEY;
if (!API_KEY) {
  console.error('ERROR: MESHY_API_KEY not set in .env');
  process.exit(1);
}

// ── Enemy prompts — uncomment the one you want to generate ──────────────
// Goblin Scout (grunt)
var PROMPT = 'A small goblin scout warrior, fantasy game character, dark green skin, worn leather armor, holding a short dagger, low poly 3D game asset, standing upright in neutral pose, no background';
var OUTPUT_PATH = path.join(__dirname, 'assets', 'goblin-scout.glb');

// Void Wolf (champion) — based on the beast in the DESTINY Wrath artwork
// var PROMPT = 'A massive quadruped wolf beast, thick grey-white fur, heavy muscular build, wide bear-like head, glowing red eyes, snarling open jaws with large ivory fangs, powerful hunched attack stance, low poly 3D game asset, no background';
// var OUTPUT_PATH = path.join(__dirname, 'assets', 'void-wolf.glb');
var POLL_INTERVAL_MS = 5000; // 5 seconds between polls

// ── helpers ──────────────────────────────────────────────────────────────────

function apiRequest(method, endpoint, body) {
  return new Promise(function(resolve, reject) {
    var parsed = url.parse('https://api.meshy.ai' + endpoint);
    var bodyStr = body ? JSON.stringify(body) : null;
    var opts = {
      hostname: parsed.hostname,
      path: parsed.path,
      method: method,
      headers: {
        'Authorization': 'Bearer ' + API_KEY,
        'Content-Type': 'application/json'
      }
    };
    if (bodyStr) opts.headers['Content-Length'] = Buffer.byteLength(bodyStr);

    var req = https.request(opts, function(res) {
      var data = '';
      res.on('data', function(chunk) { data += chunk; });
      res.on('end', function() {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(data)); } catch(e) { resolve(data); }
        } else {
          reject(new Error('HTTP ' + res.statusCode + ': ' + data));
        }
      });
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

function downloadFile(fileUrl, dest) {
  return new Promise(function(resolve, reject) {
    var parsed = url.parse(fileUrl);
    var lib = parsed.protocol === 'https:' ? https : http;
    var file = fs.createWriteStream(dest);
    lib.get(fileUrl, function(res) {
      // Follow redirects
      if (res.statusCode === 301 || res.statusCode === 302) {
        file.close();
        return downloadFile(res.headers.location, dest).then(resolve).catch(reject);
      }
      res.pipe(file);
      file.on('finish', function() { file.close(resolve); });
    }).on('error', function(err) {
      fs.unlink(dest, function(){});
      reject(err);
    });
  });
}

function sleep(ms) {
  return new Promise(function(resolve) { setTimeout(resolve, ms); });
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('─────────────────────────────────────');
  console.log('Meshy AI Enemy Generator');
  console.log('Prompt:', PROMPT);
  console.log('─────────────────────────────────────');

  // 1. Create preview task
  console.log('\n[1/3] Submitting text-to-3D task (preview mode)...');
  var createResp = await apiRequest('POST', '/openapi/v2/text-to-3d', {
    mode: 'preview',
    prompt: PROMPT,
    model_type: 'lowpoly',
    ai_model: 'meshy-6',
    should_remesh: true,
    target_polycount: 10000,
    pose_mode: 'a-pose'
  });

  var taskId = createResp.result;
  if (!taskId) { console.error('No task ID returned:', createResp); process.exit(1); }
  console.log('Task ID:', taskId);

  // 2. Poll until SUCCEEDED
  console.log('\n[2/3] Polling for completion (checking every 5s)...');
  var task;
  while (true) {
    await sleep(POLL_INTERVAL_MS);
    task = await apiRequest('GET', '/openapi/v2/text-to-3d/' + taskId);
    var status = task.status;
    var progress = task.progress || 0;
    process.stdout.write('\r  Status: ' + status + ' (' + progress + '%)   ');

    if (status === 'SUCCEEDED') { console.log('\n  Done!'); break; }
    if (status === 'FAILED' || status === 'CANCELED') {
      console.error('\n  Task failed:', task);
      process.exit(1);
    }
  }

  // 3. Download GLB
  var glbUrl = task.model_urls && task.model_urls.glb;
  if (!glbUrl) { console.error('No GLB URL in response:', task); process.exit(1); }

  console.log('\n[3/3] Downloading GLB...');
  console.log('  URL:', glbUrl);
  await downloadFile(glbUrl, OUTPUT_PATH);
  console.log('  Saved to:', OUTPUT_PATH);

  console.log('\n─────────────────────────────────────');
  console.log('Done! GLB saved to assets/goblin-scout.glb');
  console.log('Restart the game server and the goblin scout');
  console.log('enemy will automatically use this 3D model.');
  console.log('─────────────────────────────────────');
}

main().catch(function(err) {
  console.error('Error:', err.message || err);
  process.exit(1);
});
