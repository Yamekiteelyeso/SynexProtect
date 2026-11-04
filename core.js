const crypto = require('crypto');
const db = require('./db');
const DAY = 864e5;
const PLAN_MAX = 4;
const BOT_UA = /curl|wget|python|httpie|postman|insomnia|node-fetch|axios|java|go-http|discordbot|okhttp|powershell/i;

const newKey = () => crypto.randomBytes(16).toString('hex');
const newHid = () => crypto.randomBytes(14).toString('hex');
const scriptByHid = (hid) => db.prepare('select * from scripts where hid=?').get(String(hid || ''));
const slugify = (s) => String(s || '').toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '').replace(/^-+|-+$/g, '').slice(0, 24);
const maxScripts = (u) => (u.admin || u.plan === 'pro' ? Infinity : PLAN_MAX);
const scriptBySlug = (slug) => db.prepare('select * from scripts where slug=?').get(String(slug || '').toLowerCase());
const scriptForOwner = (slug, discordId) => db.prepare('select s.* from scripts s join users u on u.id=s.user_id where s.slug=? and u.discord_id=?').get(String(slug || '').toLowerCase(), String(discordId));
const expired = (k) => k.expires_at != null && k.expires_at < Date.now();
const loadstring = (slug, base, key) => `script_key="${key || 'TU_KEY'}";\nloadstring(game:HttpGet("${base}/files/v1/loaders/${slug}.lua"))()`;

const UNIT = { s: 1e3, m: 6e4, h: 36e5, d: DAY, w: 7 * DAY, y: 365 * DAY };
// "30s", "5m", "1h", "1d", "1w", "1y" -> ms. "perma"/vacío -> null (de por vida). Inválido -> undefined.
function parseDuration(v) {
  const t = String(v || '').trim().toLowerCase();
  if (!t || t === 'perma' || t === 'permanent' || t === 'lifetime') return null;
  const m = /^(\d{1,4})\s*([smhdwy])$/.exec(t);
  return m ? Number(m[1]) * UNIT[m[2]] : undefined;
}
function createKeys(scriptId, { days = null, ms = null, count = 1, owner = null } = {}) {
  const span = ms != null ? ms : days ? days * DAY : null;
  const ins = db.prepare('insert into lkeys(script_id,k,owner_discord_id,expires_at,created) values(?,?,?,?,?)');
  const out = [];
  for (let i = 0; i < count; i++) {
    const k = newKey();
    ins.run(scriptId, k, owner, span ? Date.now() + span : null, Date.now());
    out.push(k);
  }
  return out;
}

function resetHwid(k, script, force = false) {
  const period = (script.hwid_days || 7) * DAY;
  if (!force && k.hwid_reset_at && Date.now() - k.hwid_reset_at < period) {
    const left = Math.ceil((period - (Date.now() - k.hwid_reset_at)) / 36e5);
    return { error: `You can reset the HWID in ${left} h` };
  }
  db.prepare('update lkeys set hwid=null, hwid_reset_at=? where id=?').run(Date.now(), k.id);
  return { ok: true };
}

// Semilla del cifrado: depende de la key y del nonce que manda el loader. Misma fórmula en Lua.
function seedOf(key, n) {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 131 + key.charCodeAt(i)) % 2147483646;
  return ((Number(n) * 16807 + h) % 2147483646) + 1;
}
// Flujo Park-Miller (x*16807 mod 2^31-1), XOR byte a byte. Mismo algoritmo en el loader.
function cipher(buf, seed) {
  const out = Buffer.from(buf);
  let x = seed;
  for (let i = 0; i < out.length; i++) { x = (x * 16807) % 2147483647; out[i] ^= x % 256; }
  return out;
}

function runStats(scriptId) {
  const now = Date.now();
  const count = (from, to = now + 1) => db.prepare('select count(*) c from execs where script_id=? and ts>=? and ts<?').get(scriptId, from, to).c;
  const days = Array.from({ length: 14 }, (_, i) => { const from = now - (14 - i) * DAY; return count(from, from + DAY); });
  return { d1: count(now - DAY), d7: count(now - 7 * DAY), d30: count(now - 30 * DAY), total: count(0), days };
}
function payload(slug, key, hwid, n, ua) {
  const fail = (m) => cipher(Buffer.from('SYX0' + m, 'utf8'), seedOf(key, n));
  const s = scriptByHid(slug);
  if (!s || !s.enabled) return fail('Script not available');
  if (BOT_UA.test(ua || '')) return fail('Acceso bloqueado');
  if (!s.free) {
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(key)) return fail('Key inválida o faltante. Usá script_key="TU_KEY";');
    const k = db.prepare('select * from lkeys where script_id=? and k=?').get(s.id, key);
    if (!k) return fail('Key inválida');
    if (k.blacklisted || expired(k)) return fail('Key vencida o desactivada');
    if (k.owner_discord_id && db.prepare('select 1 from blacklist where script_id=? and target=?').get(s.id, k.owner_discord_id)) return fail('Tu cuenta está bloqueada en este script');
    if (!k.hwid) db.prepare('update lkeys set hwid=? where id=?').run(hwid, k.id);
    else if (k.hwid !== hwid) return fail('Key vinculada a otro dispositivo. Reiniciá el HWID.');
    db.prepare('update lkeys set uses=uses+1, last=? where id=?').run(Date.now(), k.id);
  }
  db.prepare('update scripts set runs=runs+1 where id=?').run(s.id);
  db.prepare('insert into execs(script_id,ts) values(?,?)').run(s.id, Date.now());
  return cipher(Buffer.from('SYX1' + s.content, 'utf8'), seedOf(key, n));
}

function loaderLua(slug, base) {
  return `-- Synex Protect v1
local SLUG = "${slug}"
local BASE = "${base}"
local KEY = tostring((getgenv and getgenv().script_key) or script_key or "")
local BAD = {"httpspy", "simplespy", "remotespy", "hydroxide", "dumper", "envlogger"}
local flagged = false
pcall(function()
  for name in pairs((getgenv and getgenv()) or _G) do
    local s = string.lower(tostring(name))
    for _, w in ipairs(BAD) do if string.find(s, w, 1, true) then flagged = true end end
  end
end)
if flagged then return warn("[Synex Protect] Entorno no permitido") end
local hwid = "0"
pcall(function() hwid = game:GetService("RbxAnalyticsService"):GetClientId() end)
if hwid == "0" then pcall(function() hwid = tostring(game:GetService("Players").LocalPlayer.UserId) end) end
hwid = string.gsub(hwid, "[^%w_%-%.]", "")
local n = math.random(1, 2147483640)
local h = 0
for i = 1, #KEY do h = (h * 131 + string.byte(KEY, i)) % 2147483646 end
local seed = ((n * 16807) + h) % 2147483646 + 1
local okr, body = pcall(function()
  return game:HttpGet(BASE .. "/files/v1/payload/" .. SLUG .. "?k=" .. KEY .. "&h=" .. hwid .. "&n=" .. n)
end)
if not okr or type(body) ~= "string" or #body < 4 then return warn("[Synex Protect] No se pudo cargar el script") end
local x = seed
local out = {}
for i = 1, #body do
  x = (x * 16807) % 2147483647
  out[i] = string.char(bit32.bxor(string.byte(body, i), x % 256))
end
local plain = table.concat(out)
if string.sub(plain, 1, 4) ~= "SYX1" then return warn("[Synex Protect] " .. string.sub(plain, 5)) end
local f, err = loadstring(string.sub(plain, 5))
if f then return f() end
warn(err)
`;
}

function landingHtml(slug, base) {
  const ls = `-- your loader, ready to paste\nscript_key="YOUR_KEY";\nloadstring(game:HttpGet("${base}/files/v1/loaders/${slug}.lua"))()`;
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>SynexHub</title><style>
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0912;color:#f1ecfa;font-family:system-ui,sans-serif;padding:20px}
.box{width:min(560px,100%);background:#150f20;border:1px solid #2e2347;border-radius:16px;padding:26px}
h1{margin:0 0 4px;color:#f0f0f0;font-size:28px}small{color:#a89bc2}
pre{background:#0b0912;border-radius:10px;padding:14px;overflow-x:auto;white-space:pre-wrap;word-break:break-all;color:#8ee0a0;font-size:13px}
button{background:#1c1c1c;color:#eee;border:1px solid #3a3a3a;border-radius:10px;padding:10px 16px;font-weight:700;cursor:pointer;width:100%}
</style></head><body><div class="box"><h1>SynexHub</h1><p>Copy the loader and paste it into your executor (Delta or another).</p>
<pre id="ls">${esc(ls)}</pre><button onclick="navigator.clipboard.writeText(document.getElementById('ls').innerText).then(()=>this.textContent='Copied!')">Copy loadstring</button>
</div></body></html>`;
}
module.exports = { newHid, scriptByHid, parseDuration, runStats, landingHtml,  DAY, PLAN_MAX, newKey, slugify, maxScripts, scriptBySlug, scriptForOwner, expired, loadstring, createKeys, resetHwid, seedOf, cipher, payload, loaderLua };
