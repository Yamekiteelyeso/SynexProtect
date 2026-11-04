// Shared helpers for server.js and bot.js. This file does not start a server.
const crypto = require('crypto');
const db = require('./db');

const DAY = 864e5;
const PLAN_MAX = 4; // free plan: up to 4 scripts
const now = () => Date.now();
const esc = (x) => String(x).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------- Plan ----------
const maxScripts = (user) => (user && (user.admin || user.plan === 'pro') ? Infinity : PLAN_MAX);

// ---------- Scripts ----------
const slugify = (name) => String(name || '')
  .toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 24);

const newHid = () => crypto.randomBytes(14).toString('hex');

const scriptBySlug = (slug) =>
  db.prepare('select * from scripts where slug=?').get(String(slug || '').toLowerCase()) || null;

const scriptByHid = (hid) =>
  db.prepare('select * from scripts where hid=?').get(String(hid || '').toLowerCase()) || null;

const scriptForOwner = (slug, discordId) =>
  db.prepare('select s.* from scripts s join users u on u.id=s.user_id where s.slug=? and u.discord_id=?')
    .get(String(slug || '').toLowerCase(), String(discordId)) || null;

// ---------- Stats (14 days + totals) ----------
function runStats(scriptId) {
  const t = now();
  const from = t - 14 * DAY;
  const rows = db.prepare('select ts from execs where script_id=? and ts>=?').all(scriptId, from);
  const count = (since) => rows.filter((r) => r.ts >= since).length;
  const days = Array.from({ length: 14 }, () => 0);
  for (const r of rows) {
    const i = Math.min(13, Math.floor((r.ts - from) / DAY));
    days[i] += 1;
  }
  const s = db.prepare('select runs from scripts where id=?').get(scriptId);
  return { d1: count(t - DAY), d7: count(t - 7 * DAY), d30: count(t - 30 * DAY), total: s ? s.runs : 0, days };
}

// ---------- Loader ----------
function loadstring(hid, base, key) {
  const url = `${base}/files/v1/loaders/${hid}.lua`;
  return key
    ? `script_key="${key}";\nloadstring(game:HttpGet("${url}"))()`
    : `loadstring(game:HttpGet("${url}"))()`;
}

function loaderLua(hid, base) {
  return [
    'local key = script_key or ""',
    'local hwid = game:GetService("RbxAnalyticsService"):GetClientId()',
    `local url = "${base}/files/v1/payload/${hid}?k=" .. key .. "&h=" .. hwid .. "&n=" .. tostring(os.time())`,
    'loadstring(game:HttpGet(url))()',
  ].join('\n');
}

// Public loader page (what people see when they open the loader link in a browser).
function landingHtml(hid, base) {
  const s = scriptByHid(hid);
  const name = esc(s ? s.name || s.slug : hid);
  const online = !!(s && s.enabled);
  const code = esc(loadstring(hid, base));
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${name} · Loader</title>
<style>
:root { color-scheme: dark; }
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; }
body {
  background: radial-gradient(1200px 600px at 50% -10%, #1c1c1c 0%, #0a0a0a 60%) fixed, #0a0a0a;
  color: #e6e6e6;
  font: 15px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  display: flex; align-items: center; justify-content: center; padding: 24px;
}
.card {
  width: 100%; max-width: 680px; background: #121212; border: 1px solid #262626;
  border-radius: 18px; padding: 28px; box-shadow: 0 30px 80px rgba(0,0,0,.6);
}
.head { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
h1 { margin: 0; font-size: 22px; font-weight: 700; letter-spacing: -.01em; }
.pill {
  display: inline-flex; align-items: center; gap: 7px; font-size: 12px; font-weight: 600;
  padding: 5px 11px; border-radius: 999px; border: 1px solid #2c2c2c; background: #171717; color: #8a8a8a;
}
.pill i { width: 7px; height: 7px; border-radius: 50%; background: #555; display: inline-block; }
.pill.on { color: #d6d6d6; border-color: #3a3a3a; }
.pill.on i { background: #d6d6d6; box-shadow: 0 0 10px rgba(255,255,255,.35); }
.sub { color: #7a7a7a; margin: 6px 0 24px; font-size: 14px; }
.label { font-size: 11px; text-transform: uppercase; letter-spacing: .12em; color: #6b6b6b; margin-bottom: 10px; font-weight: 600; }
.code {
  position: relative; background: #0b0b0b; border: 1px solid #222; border-radius: 12px;
  padding: 18px 110px 18px 18px;
}
pre {
  margin: 0; overflow-x: auto; white-space: pre-wrap; word-break: break-all;
  font: 13px/1.65 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; color: #cfcfcf;
}
.copy {
  position: absolute; top: 12px; right: 12px; cursor: pointer; font: inherit; font-size: 12px; font-weight: 600;
  color: #e6e6e6; background: #1f1f1f; border: 1px solid #333; border-radius: 9px; padding: 7px 14px;
  transition: background .15s, border-color .15s;
}
.copy:hover { background: #2a2a2a; border-color: #4a4a4a; }
.steps { margin: 24px 0 0; padding: 0; list-style: none; counter-reset: s; }
.steps li {
  counter-increment: s; display: flex; gap: 12px; align-items: flex-start;
  padding: 10px 0; border-top: 1px solid #1f1f1f; color: #9a9a9a; font-size: 14px;
}
.steps li:first-child { border-top: 0; }
.steps li::before {
  content: counter(s); flex: 0 0 22px; height: 22px; line-height: 22px; text-align: center;
  border-radius: 7px; background: #1c1c1c; border: 1px solid #2c2c2c; color: #bdbdbd; font-size: 12px; font-weight: 700;
}
code { font: 12px ui-monospace, Menlo, Consolas, monospace; color: #d6d6d6; background: #1a1a1a; padding: 2px 6px; border-radius: 6px; }
footer { margin-top: 26px; font-size: 12px; color: #4a4a4a; text-align: center; }
</style>
</head>
<body>
<main class="card">
  <div class="head">
    <h1>${name}</h1>
    <span class="pill ${online ? 'on' : ''}"><i></i>${online ? 'Online' : 'Paused'}</span>
  </div>
  <p class="sub">Protected script loader</p>
  <div class="label">Loader</div>
  <div class="code">
    <pre id="code">${code}</pre>
    <button class="copy" id="copy" type="button">Copy</button>
  </div>
  <ol class="steps">
    <li>Get your key from the Discord panel using <b>Redeem Key</b>.</li>
    <li>Paste your key above the loader: <code>script_key="YOUR-KEY";</code></li>
    <li>Paste the whole block into your executor and run it.</li>
  </ol>
  <footer>SynexProtect</footer>
</main>
<script>
(function () {
  var btn = document.getElementById('copy');
  var txt = document.getElementById('code').innerText;
  btn.addEventListener('click', function () {
    var done = function (ok) {
      btn.textContent = ok ? 'Copied' : 'Failed';
      setTimeout(function () { btn.textContent = 'Copy'; }, 1500);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(txt).then(function () { done(true); }, function () { done(false); });
    } else {
      var ta = document.createElement('textarea'); ta.value = txt; document.body.appendChild(ta);
      ta.select(); var ok = false; try { ok = document.execCommand('copy'); } catch (e) {} ta.remove(); done(ok);
    }
  });
})();
</script>
</body>
</html>`;
}

// ---------- Payload (script delivery) ----------
// Validates key, expiry, blacklist, HWID and script state, then returns the script.
// Errors are returned as Lua that warns in the executor, so the user sees why nothing ran.
function payload(hid, key, hwid) {
  const deny = (msg) => Buffer.from(`warn("[SynexProtect] ${msg}")`, 'utf8');
  const s = scriptByHid(hid);
  if (!s) return deny('Script not found.');
  if (!s.enabled) return deny('This script is currently paused.');
  const k = db.prepare('select * from lkeys where script_id=? and k=?').get(s.id, normKey(key));
  if (!k) return deny('Invalid key.');
  if (k.blacklisted) return deny('This key has been disabled.');
  if (expired(k)) return deny('Your key has expired.');
  if (!hwid) return deny('Could not read your HWID.');
  if (!k.hwid) db.prepare('update lkeys set hwid=? where id=?').run(hwid, k.id);
  else if (k.hwid !== hwid) return deny('HWID mismatch. Reset your HWID from the Discord panel.');
  db.prepare('update lkeys set uses=uses+1, last=? where id=?').run(now(), k.id);
  db.prepare('update scripts set runs=runs+1 where id=?').run(s.id);
  db.prepare('insert into execs(script_id,ts) values(?,?)').run(s.id, now());
  // NOTE: the script is delivered as stored in the database.
  return Buffer.from(s.content, 'utf8');
}

// ---------- Keys ----------
// Short, simple keys: 16 uppercase letters/digits, grouped XXXX-XXXX-XXXX-XXXX.
const KEY_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const newKey = () => {
  const bytes = crypto.randomBytes(16);
  let s = '';
  for (const b of bytes) s += KEY_CHARS[b % KEY_CHARS.length];
  return s.match(/.{4}/g).join('-');
};
const normKey = (v) => String(v || '').trim().toUpperCase();

function createKeys(scriptId, { ms = null, days = null, count = 1 } = {}) {
  const dur = ms != null ? ms : days ? days * DAY : null;
  const expires = dur ? now() + dur : null;
  const ins = db.prepare('insert into lkeys(script_id,k,expires_at,created) values(?,?,?,?)');
  const out = [];
  for (let i = 0; i < count; i++) {
    const k = newKey();
    ins.run(scriptId, k, expires, now());
    out.push(k);
  }
  return out;
}

const UNITS = { s: 1e3, m: 6e4, h: 36e5, d: DAY, w: 7 * DAY, y: 365 * DAY };
// Returns ms. 0 = lifetime. undefined = invalid format.
function parseDuration(v) {
  const s = String(v || '').trim().toLowerCase();
  if (s === '' || s === 'perma' || s === 'lifetime') return 0;
  const m = /^(\d+)([smhdwy])$/.exec(s);
  if (!m) return undefined;
  return Number(m[1]) * UNITS[m[2]];
}

const expired = (k) => !!k && k.expires_at != null && k.expires_at < now();

function resetHwid(k, s, force = false) {
  const days = s.hwid_days || 7;
  if (!k.hwid && !force) return { error: 'This key has no HWID linked yet.' };
  if (!force && k.hwid_reset_at && now() - k.hwid_reset_at < days * DAY) {
    const left = Math.ceil((days * DAY - (now() - k.hwid_reset_at)) / DAY);
    return { error: `You can reset your HWID once every ${days} days. ${left} day(s) left.` };
  }
  db.prepare('update lkeys set hwid=null, hwid_reset_at=? where id=?').run(now(), k.id);
  return { ok: 1 };
}

module.exports = {
  DAY, PLAN_MAX, maxScripts,
  slugify, newHid, scriptBySlug, scriptByHid, scriptForOwner,
  runStats, loadstring, loaderLua, landingHtml, payload,
  createKeys, parseDuration, expired, resetHwid, normKey,
};
