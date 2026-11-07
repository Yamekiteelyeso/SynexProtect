// Shared helpers for server.js and bot.js. This file does not start a server.
const crypto = require('crypto');
const db = require('./db');

const DAY = 864e5;
const PLAN_MAX = 2; // free plan: up to 2 scripts
const PREMIUM_MAX = 10;
const now = () => Date.now();
const esc = (x) => String(x).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------- Plan ----------
// Admins: solo los IDs de Discord de ADMIN_IDS (o la variable de entorno ADMIN_IDS).
const ADMIN_IDS = (process.env.ADMIN_IDS || '1518079144590573690,1244463634411683866').split(',').map((x) => x.trim()).filter(Boolean);
const isAdminUser = (user) => !!user && !!user.discord_id && ADMIN_IDS.includes(String(user.discord_id));
// Plus y admins: scripts ilimitados. Premium: PREMIUM_MAX. Free: PLAN_MAX.
const maxScripts = (user) => (isAdminUser(user) || (user && user.plan === 'plus') ? Infinity : user && user.plan === 'premium' ? PREMIUM_MAX : PLAN_MAX);

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

// ---------- Entrega cifrada ----------
const BOT_UA = /curl|wget|python|httpie|postman|insomnia|node-fetch|axios|java|go-http|discordbot|okhttp|powershell/i;
// Checksum de integridad (mismo cálculo en Lua): evita que cambien el payload en tránsito.
function csum(buf) {
  let h = 0;
  for (const b of buf) h = (h * 31 + b) % 2147483647;
  return String(h).padStart(10, '0');
}
// Mezclador de 32 bits (fmix32 de MurmurHash3). Math.imul = multiplicación mod 2^32; la versión Lua usa mitades de 16 bits.
function fmix32(h) {
  h >>>= 0;
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}
// Semilla: depende de la key y del nonce del loader. Misma fórmula en Lua.
function seedOf(key, n) {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 131 + key.charCodeAt(i)) % 2147483646;
  return fmix32((h ^ fmix32(Number(n))) >>> 0);
}
// Keystream en bloques de 4 bytes: cada bloque es fmix32(seed ^ (blk+1)*golden). Misma fórmula en Lua.
function cipher(buf, seed) {
  const out = Buffer.from(buf);
  for (let b = 0; b * 4 < out.length; b++) {
    const w = fmix32((seed ^ Math.imul(b + 1, 0x9E3779B9)) >>> 0);
    for (let j = 0; j < 4 && b * 4 + j < out.length; j++) out[b * 4 + j] ^= (w >>> (j * 8)) & 255;
  }
  return out;
}

function loaderLua(hid, base) {
  return `-- SynexProtect v2
local SLUG = "__HID__"
local BASE = "__BASE__"
local LS = loadstring
local function SYX_yield() if task and task.wait then task.wait() elseif wait then wait() end end
local function SYX_kick(msg)
  pcall(function() game:GetService("Players").LocalPlayer:Kick("[SynexProtect] " .. msg) end)
  error("[SynexProtect] " .. msg, 0)
end
if type(game.HttpGet) ~= "function" or type(LS) ~= "function" then return error("[SynexProtect] Tamper detected.", 0) end
-- Sanidad de las librerías base: si alguien las reemplazó, no seguimos.
if bit32.bxor(5, 3) ~= 6 or string.char(65) ~= "A" or math.floor(3.7) ~= 3 then return error("[SynexProtect] Tamper detected.", 0) end
local KEY = tostring((getgenv and getgenv().script_key) or script_key or "")
local BAD = {"httpspy", "simplespy", "remotespy", "hydroxide", "dumper", "envlogger", "sipspy", "turtlespy", "moonspy", "ruinspy"}
local BAD_EXACT = {dex = true, dexplorer = true, scriptdumper = true}
local flagged = false
pcall(function()
  for name in pairs((getgenv and getgenv()) or _G) do
    local s = string.lower(tostring(name))
    if BAD_EXACT[s] then flagged = true end
    for _, w in ipairs(BAD) do if string.find(s, w, 1, true) then flagged = true end end
  end
end)
if flagged then return SYX_kick("Entorno no permitido") end
-- Anti-hook: loadstring tiene que ser la función nativa (C). Si está envuelta en Lua, alguien la intercepta.
local hooked = false
if type(iscclosure) == "function" then
  pcall(function() if not iscclosure(LS) then hooked = true end end)
end
if hooked then return SYX_kick("Hooked loadstring.") end
local hwid = "0"
pcall(function() hwid = game:GetService("RbxAnalyticsService"):GetClientId() end)
if hwid == "0" then pcall(function() hwid = tostring(game:GetService("Players").LocalPlayer.UserId) end) end
hwid = string.gsub(hwid, "[^%w_%-%.]", "")
local n = math.random(1, 2147483640)
local T = os.time()
local PID = "0"
pcall(function() PID = tostring(game.PlaceId) end)
local UID = "0"
pcall(function() UID = tostring(game:GetService("Players").LocalPlayer.UserId) end)
local EXE = "Unknown"
pcall(function() local nm = identifyexecutor() if nm then EXE = tostring(nm) end end)
EXE = string.gsub(EXE, "[^%w_%.%-]", "_")
local UNAME = "Unknown"
pcall(function() UNAME = game:GetService("Players").LocalPlayer.Name end)
UNAME = string.gsub(tostring(UNAME), "[^%w_]", "")
-- Anti-dump por comportamiento: si loadstring escribe archivos al workspace, alguien lo tiene hookeado.
local function SYX_snap()
  local set = {}
  pcall(function()
    if listfiles then
      for _, f in ipairs(listfiles("")) do set[tostring(f)] = true end
    end
  end)
  return set
end
local function SYX_diff(a, b)
  for k in pairs(b) do if not a[k] then return true end end
  return false
end
local function SYX_tamper(reason)
  pcall(function() game:HttpGet(BASE .. "/files/v1/payload/" .. SLUG .. "?tamper=1&r=" .. reason .. "&uid=" .. UID .. "&u=" .. UNAME .. "&x=" .. EXE) end)
  return SYX_kick("Tamper detected.")
end
do
  local hit = false
  pcall(function()
    if isfolder and isfolder("fualmor") then hit = true end
    if isfile and isfile("fualmor/loadstring0.txt") then hit = true end
  end)
  if hit then return SYX_tamper("fs") end
end
local h = 0
for i = 1, #KEY do h = (h * 131 + string.byte(KEY, i)) % 2147483646 end
-- Multiplicación mod 2^32 sin perder precisión (los números de Lua son doubles).
local function SYX_mul(a, b)
  local lo = b % 65536
  local hi = (b - lo) / 65536
  return ((a * hi) % 65536 * 65536 + a * lo) % 4294967296
end
local function SYX_fmix(v)
  v = bit32.bxor(v, bit32.rshift(v, 16))
  v = SYX_mul(v, 0x85ebca6b)
  v = bit32.bxor(v, bit32.rshift(v, 13))
  v = SYX_mul(v, 0xc2b2ae35)
  return bit32.bxor(v, bit32.rshift(v, 16))
end
local function SYX_ks(seed, blk)
  return SYX_fmix(bit32.bxor(seed, SYX_mul(blk + 1, 0x9E3779B9)))
end
local seed = SYX_fmix(bit32.bxor(h, SYX_fmix(n)))
local okr, body = pcall(function()
  return game:HttpGet(BASE .. "/files/v1/payload/" .. SLUG .. "?k=" .. KEY .. "&h=" .. hwid .. "&n=" .. n .. "&t=" .. T .. "&p=" .. PID .. "&u=" .. UNAME .. "&uid=" .. UID .. "&x=" .. EXE)
end)
if not okr or type(body) ~= "string" or #body < 4 then return warn("[SynexProtect] No se pudo cargar el script") end
local W = 0
local chunks = {}
local CH = 4096
local len = #body
local pos = 1
while pos <= len do
  local last = math.min(pos + CH - 1, len)
  local buf = {}
  for k = pos, last do
    local j = (k - 1) % 4
    if j == 0 then W = SYX_ks(seed, (k - 1) / 4) end
    buf[#buf + 1] = string.char(bit32.bxor(string.byte(body, k), bit32.band(bit32.rshift(W, j * 8), 255)))
  end
  chunks[#chunks + 1] = table.concat(buf)
  pos = last + 1
  SYX_yield()
end
local plain = table.concat(chunks)
chunks = nil
body = nil
if string.sub(plain, 1, 4) == "SYX0" then
  local msg = string.sub(plain, 5)
  plain = nil
  SYX_kick(msg)
end
if string.sub(plain, 1, 4) ~= "SYX3" then plain = nil return SYX_kick("Invalid response.") end
local ns = tostring(n)
ns = string.rep("0", 10 - #ns) .. ns
-- El servidor repite el nonce: una respuesta vieja o cacheada no sirve para esta ejecución.
if string.sub(plain, 5, 14) ~= ns then plain = nil return SYX_kick("Replayed response.") end
local want = tonumber(string.sub(plain, 15, 24))
local src = string.sub(plain, 25)
plain = nil
local ck = 0
for i = 1, #src do ck = (ck * 31 + string.byte(src, i)) % 2147483647; if i % 8192 == 0 then SYX_yield() end end
if ck ~= want then src = nil return SYX_kick("Integrity check failed.") end
KEY = nil
script_key = nil
pcall(function() getgenv().script_key = nil end)
local snapBefore = SYX_snap()
if loadstring ~= LS then src = nil return SYX_tamper("hook") end
local f, err = LS(src)
if SYX_diff(snapBefore, SYX_snap()) then src = nil return SYX_tamper("loadstring") end
src = nil
if f then return f() end
warn(err)
`.replace("__HID__", hid).replace("__BASE__", base);
}

// Loader ofuscado: el texto del .get sale como hexadecimal cifrado y se decodifica al ejecutarse.
function obfLoader(src) {
  const k = crypto.randomBytes(16);
  const bytes = Buffer.from(src, 'utf8');
  let hex = '';
  for (let i = 0; i < bytes.length; i++) hex += (bytes[i] ^ k[i % k.length]).toString(16).padStart(2, '0');
  return `local d="${hex}"\nlocal k="${k.toString('hex')}"\nlocal o = {}\nfor i = 1, #d, 2 do\n  local j = math.floor((i - 1) / 2)\n  local b = tonumber(string.sub(d, i, i + 1), 16)\n  local q = tonumber(string.sub(k, (j % 16) * 2 + 1, (j % 16) * 2 + 2), 16)\n  o[#o + 1] = string.char(bit32.bxor(b, q))\nend\nreturn loadstring(table.concat(o))()\n`;
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
const usedNonces = new Map();
// Alerta a la webhook de admins (ADMIN_WEEBHOOK) cuando alguien intenta sacar el código fuente.
const ADMIN_WEBHOOK = process.env.ADMIN_WEEBHOOK || '';
function alertAdmins(ctx) {
  if (!ADMIN_WEBHOOK || !WEBHOOK_RE.test(ADMIN_WEBHOOK)) return;
  const payload = {
    username: 'Synex Alerts',
    embeds: [{
      title: 'PELIGRO',
      description: 'Un usuario intentó sacar el código fuente de uno de los scripts',
      color: 0xed4245,
      fields: [
        { name: 'User (roblox)', value: ctx.user || 'Unknown', inline: true },
        { name: 'IP', value: ctx.ip || 'Unknown', inline: true },
        { name: 'ID Roblox', value: ctx.uid || 'Unknown', inline: true },
        { name: 'Dispositivo', value: ctx.hwid || 'Unknown', inline: true },
        { name: 'Executor', value: ctx.exe || 'Unknown', inline: true },
      ],
      footer: { text: 'Synex Alerts' },
      timestamp: new Date().toISOString(),
    }],
  };
  fetch(ADMIN_WEBHOOK, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }).catch(() => {});
}
function payload(hid, key, hwid, n, ua, t, pl, pu, ctx) {
  const tamper = () => {
    alertAdmins({ user: pu, ip: ctx && ctx.ip, uid: ctx && ctx.uid, hwid, exe: ctx && ctx.exe });
    return enc('SYX0Tamper detected.');
  };
  const enc = (m) => cipher(Buffer.from(m, 'utf8'), seedOf(String(key || ''), n || '1'));
  const deny = (msg) => enc('SYX0' + msg);
  const s = scriptByHid(hid);
  if (!s) return deny('Script not found.');
  if (!s.enabled) return deny('This script is currently paused.');
  if (BOT_UA.test(ua || '')) return tamper();
  // Anti-get: el enlace solo sirve si es reciente (90 s) y su nonce no se usó antes.
  const ts = Number(t);
  if (!ts || Math.abs(Date.now() / 1000 - ts) > 90) return deny('Request expired.');
  const nk = s.id + ':' + n;
  const nowMs = Date.now();
  for (const [k2, v2] of usedNonces) if (nowMs - v2 > 180e3) usedNonces.delete(k2);
  if (usedNonces.has(nk)) return tamper();
  usedNonces.set(nk, nowMs);

  let k = null;
  if (!s.free) {
    if (!String(key || '').trim()) return deny('NO KEY DETECT');
    k = db.prepare('select * from lkeys where script_id=? and k=?').get(s.id, normKey(key));
    if (!k) return deny('Key does not exist.');
    if (k.blacklisted) return deny('This key has been disabled.');
    if (expired(k)) return deny('Your key has expired.');
    if (!hwid) return deny('Could not read your HWID.');
    if (!k.hwid) db.prepare('update lkeys set hwid=? where id=?').run(hwid, k.id);
    else if (k.hwid !== hwid) return deny('Key is linked to a different HWID.');
    if (!ctx || !ctx.uid) return deny('Could not read your Roblox account.');
    if (!k.rbx_uid) db.prepare('update lkeys set rbx_uid=? where id=?').run(ctx.uid, k.id);
    else if (k.rbx_uid !== ctx.uid) return deny('Key is linked to a different Roblox account.');
    db.prepare('update lkeys set uses=uses+1, last=? where id=?').run(now(), k.id);
  }
  db.prepare('update scripts set runs=runs+1 where id=?').run(s.id);
  db.prepare('insert into execs(script_id,ts) values(?,?)').run(s.id, now());
  if (s.webhook_on && s.webhook_url) sendExecWebhook(s, k || { k: 'FREE (no key)', uses: 0 }, pl, pu);
  const body = Buffer.from(s.content, 'utf8');
  return enc('SYX3' + String(n).padStart(10, '0') + csum(body) + body.toString('utf8'));
}

// ---------- Webhook de ejecución (embed gris, en inglés) ----------
const WEBHOOK_RE = /^https:\/\/(discord|discordapp)\.com\/api\/webhooks\/\d+\/[\w-]+$/;
function sendExecWebhook(s, k, placeId, robloxUser) {
  const name = s.name || s.slug;
  const payload = {
    username: 'SynexProtect',
    embeds: [{
      title: `${name} - Script executed`,
      color: 0x2b2d31,
      fields: [
        { name: 'User (Roblox)', value: robloxUser || 'Unknown', inline: true },
        { name: 'Executions (user)', value: String((k.uses || 0) + 1), inline: true },
        { name: 'PlaceId', value: placeId || 'Unknown', inline: true },
        { name: 'Key', value: `\`${k.k}\``, inline: false },
      ],
      footer: { text: 'SynexProtect Executes' },
      timestamp: new Date().toISOString(),
    }],
  };
  fetch(s.webhook_url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }).catch(() => {});
}

// ---------- Keys ----------
// Short, simple keys: 16 uppercase letters/digits, grouped XXXX-XXXX-XXXX-XXXX.
// Keys: exactamente 32 caracteres alfanuméricos, con mayúsculas, minúsculas y números.
const KEY_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const newKey = () => {
  for (;;) {
    const bytes = crypto.randomBytes(32);
    let s = '';
    for (const b of bytes) s += KEY_CHARS[b % KEY_CHARS.length];
    s = s.slice(0, 32);
    if (/[A-Z]/.test(s) && /[a-z]/.test(s) && /[0-9]/.test(s)) return s;
  }
};
const normKey = (v) => String(v || '').trim();

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
  WEBHOOK_RE, DAY, PLAN_MAX, PREMIUM_MAX, maxScripts, isAdminUser, ADMIN_IDS,
  slugify, newHid, scriptBySlug, scriptByHid, scriptForOwner,
  runStats, loadstring, loaderLua, obfLoader, landingHtml, payload, alertAdmins,
  createKeys, parseDuration, expired, resetHwid, normKey,
};
