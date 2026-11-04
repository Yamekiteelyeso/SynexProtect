// Helpers compartidos por server.js y bot.js.
// Este archivo NO levanta servidor: solo exporta funciones.
const crypto = require('crypto');
const db = require('./db');

const DAY = 864e5;
const PLAN_MAX = 4; // plan gratis: hasta 4 scripts (ver README)
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

// ---------- Estadísticas (14 días + totales) ----------
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

function landingHtml(hid, base) {
  const s = scriptByHid(hid);
  const name = esc(s ? s.name || s.slug : hid);
  return `<!doctype html><meta charset="utf-8"><title>${name}</title>` +
    `<body style="font-family:sans-serif;background:#0b0b0b;color:#eee;padding:24px">` +
    `<h1>${name}</h1><p>Usá este loader en tu executor:</p><pre>${esc(loadstring(hid, base))}</pre></body>`;
}

// ---------- Payload (entrega del script) ----------
// IMPORTANTE: el README dice que el código viaja cifrado. Esa parte estaba en el core.js original,
// que no está en el zip. Mientras no se restaure, este payload falla cerrado: NO entrega código en claro.
function payload(hid, key, hwid, _nonce, _ua) {
  const deny = (msg) => Buffer.from(`-- SynexProtect: ${msg}`, 'utf8');
  const s = scriptByHid(hid);
  if (!s || !s.enabled) return deny('script no disponible');
  console.error('[payload] cifrado no restaurado: restaurar core.js original antes de entregar scripts');
  return deny('entrega no configurada');
}

// ---------- Keys ----------
const newKey = () => 'SYNEX-' + crypto.randomBytes(12).toString('hex').toUpperCase().match(/.{1,6}/g).join('-');

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
// Devuelve ms; 0 = perma; undefined = formato inválido.
function parseDuration(v) {
  const s = String(v || '').trim().toLowerCase();
  // Vacío = no se pasó "duration" en el comando. El slash command documenta
  // "default: perma" cuando se omite, pero antes caía en el regex de abajo,
  // no matcheaba nada y devolvía undefined -> "Invalid duration" siempre
  // que no se especificaba duración.
  if (s === '' || s === 'perma' || s === 'lifetime') return 0;
  const m = /^(\d+)([smhdwy])$/.exec(s);
  if (!m) return undefined;
  return Number(m[1]) * UNITS[m[2]];
}

const expired = (k) => !!k && k.expires_at != null && k.expires_at < now();

function resetHwid(k, s, force = false) {
  const days = s.hwid_days || 7;
  if (!k.hwid && !force) return { error: 'Esa key no tiene HWID vinculado.' };
  if (!force && k.hwid_reset_at && now() - k.hwid_reset_at < days * DAY) {
    const left = Math.ceil((days * DAY - (now() - k.hwid_reset_at)) / DAY);
    return { error: `Solo podés resetear el HWID cada ${days} días. Faltan ${left}.` };
  }
  db.prepare('update lkeys set hwid=null, hwid_reset_at=? where id=?').run(now(), k.id);
  return { ok: 1 };
}

module.exports = {
  DAY, PLAN_MAX, maxScripts,
  slugify, newHid, scriptBySlug, scriptByHid, scriptForOwner,
  runStats, loadstring, loaderLua, landingHtml, payload,
  createKeys, parseDuration, expired, resetHwid,
};
