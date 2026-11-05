const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const db = require('./db');
const C = require('./core');

// ---------- Llaves de plan (Premium / Plus) ----------
db.exec('create table if not exists plan_keys(id integer primary key, k text unique not null, plan text not null, created integer, used_by integer, used_at integer);');
const RU = 'ABCDEFGHJKLMNPQRSTUVWXYZ', RD = '0123456789', RM = RU + RD + 'abcdefghjkmnpqrstuvwxyz';
const rnd = (chars, n) => { let s = ''; for (let i = 0; i < n; i++) s += chars[crypto.randomInt(chars.length)]; return s; };
try { db.exec('alter table plan_keys add column dur integer'); } catch {}
try { db.exec('alter table users add column plan_expires integer'); } catch {}
try { db.exec('alter table users add column banned integer default 0'); } catch {}
try { db.exec('alter table scripts add column webhook_url text'); } catch {}
try { db.exec('alter table scripts add column webhook_on integer default 0'); } catch {}
try { db.exec('alter table lkeys add column rbx_uid text'); } catch {}
try { db.exec('alter table users add column blacklisted integer default 0'); } catch {}
// Duraciones de llaves de plan (m = mes, no minuto)
const PLAN_DUR = { '1s': 1e3, '1d': 864e5, '2d': 2 * 864e5, '1w': 7 * 864e5, '1m': 30 * 864e5, '1y': 365 * 864e5, perma: 0 };
const genPlanKey = (plan) => plan === 'plus'
  ? `PLUS_${rnd(RD, 4)}${rnd(RU, 5)}${rnd(RM, 5)}-${rnd(RD, 2)}`
  : `PREMIUM_${rnd(RM, 8)}${rnd(RD, 5)}${rnd(RM, 4)}_${rnd(RD, 2)}`;

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; img-src 'self' data: https://cdn.discordapp.com; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'",
  });
  if (req.secure || req.protocol === 'https') res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
});
app.use(express.json({ limit: '20mb' }));

// Límite de peticiones por IP (en memoria)
const hits = new Map();
function limit(name, max, windowMs) {
  return (req, res, next) => {
    const key = name + ':' + req.ip;
    const t = Date.now();
    let e = hits.get(key);
    if (!e || t > e.reset) { e = { c: 0, reset: t + windowMs }; hits.set(key, e); }
    e.c++;
    if (e.c > max) {
      res.set('Retry-After', String(Math.ceil((e.reset - t) / 1000)));
      return res.status(429).json({ error: 'Demasiadas solicitudes, esperá un momento.' });
    }
    next();
  };
}
setInterval(() => { const t = Date.now(); for (const [k, v] of hits) if (t > v.reset) hits.delete(k); }, 60e3).unref();

// Protección CSRF básica: las peticiones que cambian datos solo pueden venir del mismo sitio
app.use('/api', (req, res, next) => {
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    const o = req.headers.origin;
    if (o) {
      try { if (new URL(o).host !== req.headers.host) return res.status(403).json({ error: 'Origen no permitido' }); }
      catch { return res.status(403).json({ error: 'Origen no permitido' }); }
    }
  }
  next();
});
app.use('/api', (req, res, next) => (req.method === 'POST' ? limit('post', 40, 60e3)(req, res, next) : next()));
app.use('/api/admin', limit('admin', 120, 60e3));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

const SECRET = process.env.SESSION_SECRET || (() => {
  const f = path.join(path.dirname(db.DB_FILE), 'session.key');
  try { return fs.readFileSync(f, 'utf8').trim(); }
  catch { const k = crypto.randomBytes(32).toString('hex'); try { fs.writeFileSync(f, k); } catch {} return k; }
})();
const CID = process.env.DISCORD_CLIENT_ID || '';
const CSEC = process.env.DISCORD_CLIENT_SECRET || '';
const BASE_ENV = (process.env.BASE_URL || '').replace(/\/$/, '');
const RAIL = process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : '';
const hashPass = (p) => { const salt = crypto.randomBytes(16).toString('hex'); return salt + ':' + crypto.scryptSync(p, salt, 64).toString('hex'); };
const verifyPass = (p, stored) => {
  const [salt, hex] = String(stored || '').split(':');
  if (!salt || !hex) return false;
  const k = crypto.scryptSync(p, salt, 64), e = Buffer.from(hex, 'hex');
  return e.length === k.length && crypto.timingSafeEqual(k, e);
};
const tries = new Map();
const limited = (req) => {
  const now = Date.now(), a = (tries.get(req.ip) || []).filter((t) => now - t < 9e5);
  a.push(now); tries.set(req.ip, a);
  return a.length > 10;
};
const normBase = (v) => {
  let t = String(v || '').trim();
  if (!t) return '';
  if (!/^https?:\/\//i.test(t)) t = 'https://' + t;
  try { const u = new URL(t); return u.hostname.includes('.') || u.hostname === 'localhost' ? u.origin : ''; } catch { return ''; }
};
const base = (req) => normBase(process.env.BASE_URL) || normBase(process.env.RAILWAY_PUBLIC_DOMAIN) || `${req.protocol}://${req.get('host')}`;
console.log('[oauth] base URL:', base({ protocol: 'https', get: () => '' }) || '(se toma de la petición)');

function setSess(req, res, id) {
  const t = jwt.sign({ id }, SECRET, { expiresIn: '30d' });
  res.cookie('sx', t, { httpOnly: true, sameSite: 'lax', secure: req.protocol === 'https', maxAge: 30 * 864e5 });
}
function auth(req, res, next) {
  try {
    const p = jwt.verify(req.cookies.sx || '', SECRET);
    const u = db.prepare('select * from users where id=?').get(p.id);
    if (!u) throw new Error('no user');
    if (u.plan_expires && u.plan_expires < Date.now()) { const old = u.plan; db.prepare('update users set plan=?, plan_expires=null where id=?').run('free', u.id); u.plan = 'free'; u.plan_expires = null; }
    if (u.banned) throw Object.assign(new Error('banned'), { banned: true });
    req.user = u;
    next();
  } catch (e) {
    if (e.banned) return res.status(403).json({ error: 'Tu cuenta fue baneada' });
    res.status(401).json({ error: 'Iniciá sesión con Discord' });
  }
}
function ownScript(req, res, next) {
  const s = db.prepare('select * from scripts where id=? and user_id=?').get(Number(req.params.id), req.user.id);
  if (!s) return res.status(404).json({ error: 'No existe' });
  req.script = s; next();
}

// ---------- Login con Discord ----------
app.get('/auth/discord', (req, res) => {
  const st = crypto.randomBytes(16).toString('hex');
  res.cookie('sxs', st, { httpOnly: true, sameSite: 'lax', maxAge: 6e5 });
  if (req.query.link === '1') res.cookie('sxl', '1', { httpOnly: true, sameSite: 'lax', maxAge: 6e5 });
  res.cookie('sxm', req.query.mode === 'register' ? 'register' : 'login', { httpOnly: true, sameSite: 'lax', maxAge: 6e5 });
  const u = new URL('https://discord.com/oauth2/authorize');
  u.search = new URLSearchParams({ client_id: CID, response_type: 'code', redirect_uri: `${base(req)}/auth/discord/callback`, scope: 'identify', state: st }).toString();
  console.log('[oauth] redirect_uri enviada a Discord:', `${base(req)}/auth/discord/callback`);
  res.redirect(u.toString());
});
app.get('/auth/discord/callback', async (req, res) => {
  try {
    if (!req.query.code || req.query.state !== req.cookies.sxs) return res.redirect('/?e=state');
    const tr = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: CID, client_secret: CSEC, grant_type: 'authorization_code', code: req.query.code, redirect_uri: `${base(req)}/auth/discord/callback` }),
    });
    const t = await tr.json();
    if (!t.access_token) return res.redirect('/?e=token');
    const d = await (await fetch('https://discord.com/api/users/@me', { headers: { Authorization: 'Bearer ' + t.access_token } })).json();
    if (!d.id) return res.redirect('/?e=perfil');
    if (req.cookies.sxl) {
      res.clearCookie('sxl');
      let uid = null;
      try { uid = jwt.verify(req.cookies.sx || '', SECRET).id; } catch {}
      if (!uid) return res.redirect('/?e=state');
      if (db.prepare('select id from users where discord_id=? and id<>?').get(d.id, uid)) return res.redirect('/?e=linked');
      db.prepare('update users set discord_id=? where id=?').run(d.id, uid);
      return res.redirect('/');
    }
    const mode = req.cookies.sxm === 'register' ? 'register' : 'login';
    res.clearCookie('sxm');
    if (mode === 'login' && !db.prepare('select 1 from users where discord_id=?').get(d.id)) return res.redirect('/?e=noacct');
    db.prepare('insert into users(discord_id,username,plan,created) values(?,?,?,?) on conflict(discord_id) do update set username=excluded.username')
      .run(d.id, d.username, 'free', Date.now());
    const u = db.prepare('select id from users where discord_id=?').get(d.id);
    setSess(req, res, u.id);
    res.redirect('/');
  } catch (e) { console.error('[oauth]', e); res.redirect('/?e=oauth'); }
});
app.post('/api/register', (req, res) => {
  if (limited(req)) return res.status(429).json({ error: 'Demasiados intentos, esperá unos minutos' });
  const { username, email, password } = req.body || {};
  const un = String(username || '').trim(), em = String(email || '').trim().toLowerCase();
  if (!/^[A-Za-z0-9_]{3,20}$/.test(un)) return res.status(400).json({ error: 'Usuario: 3-20 letras, números o _' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em)) return res.status(400).json({ error: 'Correo inválido' });
  if (typeof password !== 'string' || password.length < 8 || password.length > 72) return res.status(400).json({ error: 'La contraseña debe tener 8-72 caracteres' });
  if (db.prepare('select 1 from users where email=?').get(em)) return res.status(409).json({ error: 'Ese correo ya está registrado' });
  const r = db.prepare('insert into users(username,email,pass,plan,created) values(?,?,?,?,?)').run(un, em, hashPass(password), 'free', Date.now());
  setSess(req, res, Number(r.lastInsertRowid));
  res.json({ ok: 1 });
});
app.post('/api/login', (req, res) => {
  if (limited(req)) return res.status(429).json({ error: 'Demasiados intentos, esperá unos minutos' });
  const { email, password } = req.body || {};
  const u = db.prepare('select id, pass from users where email=?').get(String(email || '').trim().toLowerCase());
  if (!u || !u.pass || typeof password !== 'string' || !verifyPass(password, u.pass)) return res.status(401).json({ error: 'Correo o contraseña incorrectos' });
  if (db.prepare('select banned from users where id=?').get(u.id).banned) return res.status(403).json({ error: 'Tu cuenta fue baneada' });
  setSess(req, res, u.id);
  res.json({ ok: 1 });
});
app.post('/api/logout', (req, res) => { res.clearCookie('sx'); res.json({ ok: 1 }); });

// ---------- API del panel web ----------
app.get('/api/me', auth, (req, res) => {
  const max = C.maxScripts(req.user);
  res.json({
    username: req.user.username, email: req.user.email || null, discord: !!req.user.discord_id, admin: C.isAdminUser(req.user), is_admin: C.isAdminUser(req.user), plan: req.user.plan,
    max: max === Infinity ? null : max,
    invite: `https://discord.com/oauth2/authorize?client_id=${CID}&scope=bot+applications.commands&permissions=8`,
  });
});
app.get('/api/scripts', auth, (req, res) => {
  const rows = db.prepare('select id,hid,slug,name,enabled,free,expiry_dm,buyer_role_id,hwid_days,runs,webhook_url,webhook_on,created,(select count(*) from lkeys where script_id=scripts.id) keys from scripts where user_id=? order by id desc').all(req.user.id);
  const b = base(req);
  res.json(rows.map((r) => {
    const k = db.prepare('select k from lkeys where script_id=? and blacklisted=0 order by id limit 1').get(r.id);
    const st = C.runStats(r.id);
    return { ...r, loadstring: C.loadstring(r.hid, b, k && k.k), d1: st.d1, d7: st.d7, d30: st.d30 };
  }));
});
app.post('/api/scripts', auth, (req, res) => {
  if (req.user.blacklisted) return res.status(403).json({ error: 'Tu cuenta está en blacklist y no puede crear scripts' });
  const { name, content, free } = req.body || {};
  const count = db.prepare('select count(*) c from scripts where user_id=?').get(req.user.id).c;
  const max = C.maxScripts(req.user);
  if (count >= max) return res.status(403).json({ error: `You already have ${max} scripts. Delete one or upgrade your plan.` });
  const limit = C.isAdminUser(req.user) ? 100 * 1048576 : 1048576;
  if (typeof content !== 'string' || !content.trim() || Buffer.byteLength(content) > limit) return res.status(400).json({ error: `Script vacío o pesa más de ${req.user.admin ? '100 MB' : '1 MB'}` });
  let slug = C.slugify(name);
  if (slug.length < 3) return res.status(400).json({ error: 'Nombre: 3-24 caracteres, letras, números o guiones' });
  if (C.scriptBySlug(slug)) slug = (slug.slice(0, 19) + '-' + crypto.randomBytes(2).toString('hex')).slice(0, 24);
  db.prepare('insert into scripts(user_id,hid,slug,name,content,free,created) values(?,?,?,?,?,?,?)').run(req.user.id, C.newHid(), slug, String(name || slug).slice(0, 40), content, free ? 1 : 0, Date.now());
  const wh = String((req.body || {}).webhook_url || '').trim();
  const wsc = db.prepare('select id from scripts where slug=? and user_id=?').get(slug, req.user.id);
  if (wsc) db.prepare('update scripts set webhook_url=?, webhook_on=? where id=?').run(C.WEBHOOK_RE.test(wh) ? wh : null, (req.body || {}).webhook_on && C.WEBHOOK_RE.test(wh) ? 1 : 0, wsc.id);
  res.json({ ok: 1, slug });
});
app.patch('/api/scripts/:id', auth, ownScript, (req, res) => {
  const b = req.body || {};
  if (typeof b.enabled === 'boolean') db.prepare('update scripts set enabled=? where id=?').run(b.enabled ? 1 : 0, req.script.id);
  if (typeof b.free === 'boolean') db.prepare('update scripts set free=? where id=?').run(b.free ? 1 : 0, req.script.id);
  if (typeof b.expiry_dm === 'boolean') db.prepare('update scripts set expiry_dm=? where id=?').run(b.expiry_dm ? 1 : 0, req.script.id);
  if (typeof b.buyer_role_id === 'string') db.prepare('update scripts set buyer_role_id=? where id=?').run(/^\d{5,25}$/.test(b.buyer_role_id) ? b.buyer_role_id : null, req.script.id);
  if (typeof b.webhook_url === 'string') {
    const w = b.webhook_url.trim();
    if (w && !C.WEBHOOK_RE.test(w)) return res.status(400).json({ error: 'Webhook de Discord inválido' });
    db.prepare('update scripts set webhook_url=? where id=?').run(w || null, req.script.id);
  }
  if (typeof b.webhook_on === 'boolean') db.prepare('update scripts set webhook_on=? where id=?').run(b.webhook_on ? 1 : 0, req.script.id);
  if (b.hwid_days != null) {
    const d = Math.min(365, Math.max(1, parseInt(b.hwid_days, 10) || 7));
    db.prepare('update scripts set hwid_days=? where id=?').run(d, req.script.id);
  }
  res.json({ ok: 1 });
});
app.delete('/api/scripts/:id', auth, ownScript, (req, res) => {
  db.prepare('delete from lkeys where script_id=?').run(req.script.id);
  db.prepare('delete from blacklist where script_id=?').run(req.script.id);
  db.prepare('delete from panels where script_id=?').run(req.script.id);
  db.prepare('delete from scripts where id=?').run(req.script.id);
  res.json({ ok: 1 });
});
app.get('/api/scripts/:id/stats', auth, ownScript, (req, res) => res.json(C.runStats(req.script.id)));
app.get('/api/scripts/:id/keys', auth, ownScript, (req, res) => {
  res.json(db.prepare('select id,k,owner_discord_id,expires_at,hwid,blacklisted,uses,last from lkeys where script_id=? order by id desc').all(req.script.id));
});
app.post('/api/scripts/:id/keys', auth, ownScript, (req, res) => {
  const count = Math.min(50, Math.max(1, parseInt((req.body || {}).count, 10) || 1));
  const days = parseInt((req.body || {}).days, 10) || null;
  res.json({ keys: C.createKeys(req.script.id, { days, count }) });
});
app.delete('/api/keys/:kid', auth, (req, res) => {
  const k = db.prepare('select lkeys.id from lkeys join scripts s on s.id=lkeys.script_id join users u on u.id=s.user_id where lkeys.id=? and u.id=?').get(Number(req.params.kid), req.user.id);
  if (!k) return res.status(404).json({ error: 'No existe' });
  db.prepare('delete from lkeys where id=?').run(k.id);
  res.json({ ok: 1 });
});

// Expiración: revisa cada 5 min los planes vencidos y los pasa a Free (solo en la web).
function sweepPlans() {
  db.prepare("update users set plan='free', plan_expires=null where plan_expires is not null and plan_expires < ? and plan <> 'free'").run(Date.now());
}
sweepPlans();
setInterval(sweepPlans, 5 * 60e3);

// ---------- Canjear llave de plan ----------
app.post('/api/plan/redeem', limit('redeem', 10, 60e3), auth, (req, res) => {
  if (req.user.blacklisted) return res.status(403).json({ error: 'Tu cuenta está en blacklist' });
  const code = String((req.body || {}).code || '').trim();
  if (!code.startsWith('PREMIUM_') && !code.startsWith('PLUS_')) return res.status(400).json({ error: 'Formato de llave inválido' });
  const k = db.prepare('select * from plan_keys where k=? and used_by is null').get(code);
  if (!k) return res.status(404).json({ error: 'Llave inválida o ya usada' });
  db.prepare('update plan_keys set used_by=?, used_at=? where id=?').run(req.user.id, Date.now(), k.id);
  const exp = k.dur ? Date.now() + k.dur : null;
  const oldPlan = req.user.plan;
  db.prepare('update users set plan=?, plan_expires=? where id=?').run(k.plan, exp, req.user.id);
  res.json({ ok: 1, plan: k.plan });
});

// ---------- Admin (solo IDs de ADMIN_IDS) ----------
db.exec('create table if not exists admin_logs(id integer primary key, admin_id integer, ip text, method text, path text, body text, ts integer)');
function adminOnly(req, res, next) {
  if (!C.isAdminUser(req.user)) return res.status(403).json({ error: 'Solo admins' });
  if (req.method !== 'GET') {
    try { db.prepare('insert into admin_logs(admin_id,ip,method,path,body,ts) values(?,?,?,?,?,?)').run(req.user.id, req.ip, req.method, String(req.originalUrl).slice(0, 200), JSON.stringify(req.body || {}).slice(0, 500), Date.now()); } catch {}
  }
  next();
}
app.get('/api/admin/logs', auth, adminOnly, (req, res) => {
  res.json(db.prepare('select * from admin_logs order by id desc limit 200').all());
});
app.get('/api/admin/overview', auth, adminOnly, (req, res) => {
  const scripts = db.prepare(`select s.id,s.slug,s.name,s.enabled,s.runs,u.username owner,
    (select count(*) from lkeys where script_id=s.id) keys from scripts s left join users u on u.id=s.user_id order by s.id desc limit 300`).all()
    .map((s) => ({ ...s, d30: C.runStats(s.id).d30 }));
  const users = db.prepare('select id,username,discord_id,email,plan,created from users order by id desc limit 300').all();
  const plankeys = db.prepare(`select pk.id,pk.k,pk.plan,pk.dur,pk.created,pk.used_at,u.username used_by from plan_keys pk
    left join users u on u.id=pk.used_by order by pk.id desc limit 200`).all();
  res.json({ scripts, users, plankeys, totals: { users: users.length, scripts: scripts.length, keys: scripts.reduce((a, s) => a + (s.keys || 0), 0), runs30: scripts.reduce((a, s) => a + (s.d30 || 0), 0) } });
});
app.post('/api/admin/plankeys', auth, adminOnly, (req, res) => {
  const plan = (req.body || {}).plan === 'plus' ? 'plus' : (req.body || {}).plan === 'premium' ? 'premium' : null;
  if (!plan) return res.status(400).json({ error: 'Plan inválido' });
  const count = Math.min(50, Math.max(1, parseInt((req.body || {}).count, 10) || 1));
  const durName = Object.prototype.hasOwnProperty.call(PLAN_DUR, (req.body || {}).dur) ? (req.body || {}).dur : null;
  if (!durName) return res.status(400).json({ error: 'Duración inválida' });
  const ins = db.prepare('insert into plan_keys(k,plan,dur,created) values(?,?,?,?)');
  const keys = [];
  for (let i = 0; i < count; i++) { const k = genPlanKey(plan); ins.run(k, plan, PLAN_DUR[durName] || null, Date.now()); keys.push(k); }
  res.json({ keys });
});
app.delete('/api/admin/plankeys/:id', auth, adminOnly, (req, res) => {
  const k = db.prepare('select * from plan_keys where id=?').get(Number(req.params.id));
  if (k && k.used_by) {
    const u = db.prepare('select * from users where id=?').get(k.used_by);
    if (u && u.plan !== 'free') {
      db.prepare("update users set plan='free', plan_expires=null where id=?").run(u.id);
      }
  }
  db.prepare('delete from plan_keys where id=?').run(Number(req.params.id));
  res.json({ ok: 1 });
});
app.post('/api/admin/grant', auth, adminOnly, (req, res) => {
  const { discord_id, plan } = req.body || {};
  const id = String(discord_id || '').trim();
  if (!/^\d{5,25}$/.test(id)) return res.status(400).json({ error: 'Discord ID inválido' });
  if (!['free', 'premium', 'plus'].includes(plan)) return res.status(400).json({ error: 'Plan inválido' });
  const u = db.prepare('select id from users where discord_id=?').get(id);
  if (u) { const old = db.prepare('select plan from users where id=?').get(u.id).plan; db.prepare('update users set plan=?, plan_expires=null where id=?').run(plan, u.id); }
  else db.prepare('insert into users(discord_id,username,plan,created) values(?,?,?,?)').run(id, 'user' + id.slice(-6), plan, Date.now());
  res.json({ ok: 1 });
});
app.post('/api/admin/users/:id/plan', auth, adminOnly, (req, res) => {
  const plan = (req.body || {}).plan;
  if (!['free', 'premium', 'plus'].includes(plan)) return res.status(400).json({ error: 'Plan inválido' });
  const t = db.prepare('select * from users where id=?').get(Number(req.params.id));
  if (!t) return res.status(404).json({ error: 'No existe' });
  db.prepare('update users set plan=?, plan_expires=null where id=?').run(plan, t.id);
  res.json({ ok: 1 });
});
app.get('/api/admin/users', auth, adminOnly, (req, res) => {
  const q = String((req.query || {}).q || '').trim().slice(0, 64);
  const like = `%${q}%`;
  const rows = q
    ? db.prepare(`select id,username,discord_id,email,plan,plan_expires,banned,blacklisted,created from users
        where username like ? or discord_id like ? or cast(id as text) = ? order by id desc limit 100`).all(like, like, q)
    : db.prepare('select id,username,discord_id,email,plan,plan_expires,banned,blacklisted,created from users order by id desc limit 100').all();
  res.json(rows);
});
app.post('/api/admin/users/:id/ban', auth, adminOnly, (req, res) => {
  const t = db.prepare('select * from users where id=?').get(Number(req.params.id));
  if (!t) return res.status(404).json({ error: 'No existe' });
  if (C.isAdminUser(t)) return res.status(400).json({ error: 'No podés banear a un admin' });
  db.prepare('update users set banned=? where id=?').run((req.body || {}).value ? 1 : 0, t.id);
  res.json({ ok: 1 });
});
app.post('/api/admin/users/:id/blacklist', auth, adminOnly, (req, res) => {
  const t = db.prepare('select * from users where id=?').get(Number(req.params.id));
  if (!t) return res.status(404).json({ error: 'No existe' });
  if (C.isAdminUser(t)) return res.status(400).json({ error: 'No podés poner en blacklist a un admin' });
  db.prepare('update users set blacklisted=? where id=?').run((req.body || {}).value ? 1 : 0, t.id);
  res.json({ ok: 1 });
});
app.patch('/api/admin/scripts/:id', auth, adminOnly, (req, res) => {
  if (typeof (req.body || {}).enabled === 'boolean') db.prepare('update scripts set enabled=? where id=?').run(req.body.enabled ? 1 : 0, Number(req.params.id));
  res.json({ ok: 1 });
});

// ---------- Archivos públicos del loader (v1) ----------
app.get('/s/:slug', (req, res) => {
  const slug = String(req.params.slug).toLowerCase();
  if (!C.scriptByHid(slug)) return res.status(404).type('text/html').send('<h1>Not found</h1>');
  res.type('text/html').set('Cache-Control', 'no-store').send(C.landingHtml(slug, base(req)));
});
app.get('/files/v1/loaders/:file', (req, res) => {
  const slug = String(req.params.file).replace(/\.lua$/, '').toLowerCase();
  const s = C.scriptByHid(slug);
  if (!s) return res.status(404).type('text/plain').send('-- not found');
  if (req.accepts(['html', 'text']) === 'html' && !/Roblox/i.test(req.headers['user-agent'] || '')) return res.redirect(`/s/${slug}`);
  res.type('text/plain').set('Cache-Control', 'no-store').send(C.obfLoader(C.loaderLua(slug, base(req))));
});
app.get('/files/v1/payload/:slug', limit('payload', 60, 60e3), (req, res) => {
  const q = req.query;
  const key = String(q.k || ''), hwid = String(q.h || ''), n = String(q.n || '');
  const pl = /^\d{1,20}$/.test(String(q.p || '')) ? String(q.p) : '';
  const pu = /^[A-Za-z0-9_]{0,20}$/.test(String(q.u || '')) ? String(q.u) : '';
  const uid = /^\d{1,20}$/.test(String(q.uid || '')) ? String(q.uid) : '';
  const exe = /^[A-Za-z0-9_.-]{0,40}$/.test(String(q.x || '')) ? String(q.x) : '';
  const ctx = { ip: req.ip, uid, exe };
  // Sin los parámetros del loader (intento de descarga directa): alerta y corte.
  const flowOk = /^\d{1,10}$/.test(n) && /^\d{1,12}$/.test(String(q.t || '')) && /^[A-Za-z0-9_.-]{1,80}$/.test(hwid);
  if (!flowOk) {
    C.alertAdmins({ user: pu, ip: req.ip, uid, hwid, exe });
    return res.type('application/octet-stream').set('Cache-Control', 'no-store').send(C.payload(String(req.params.slug).toLowerCase(), '', '', '0', '', '0', '', '', ctx));
  }
  const buf = C.payload(String(req.params.slug).toLowerCase(), key, hwid, n, req.headers['user-agent'], q.t, pl, pu, ctx);
  res.type('application/octet-stream').set('Cache-Control', 'no-store').send(buf);
});

app.get('/health', (req, res) => res.json({ ok: true }));
const PORT = Number(process.env.PORT) || 3000;
let botStarted = false;
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'Archivo demasiado grande' });
  if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Solicitud inválida' });
  console.error('[server]', err && err.message);
  res.status(500).json({ error: 'Error interno' });
});
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log('[web] listo en puerto', PORT);
  if (!botStarted && process.env.DISCORD_BOT_TOKEN) { botStarted = true; require('./bot').start(); }
});
// Si Railway levanta dos instancias a la vez (deploys superpuestos), la segunda espera en vez de caerse.
server.on('error', (e) => {
  if (e.code !== 'EADDRINUSE') throw e;
  console.error('[web] puerto', PORT, 'ocupado, reintento en 3 s');
  setTimeout(() => server.listen(PORT, '0.0.0.0'), 3000);
});
