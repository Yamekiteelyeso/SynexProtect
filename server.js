const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const db = require('./db');
const C = require('./core');

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '105mb' }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

const SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const CID = process.env.DISCORD_CLIENT_ID || '';
const CSEC = process.env.DISCORD_CLIENT_SECRET || '';
const BASE_ENV = (process.env.BASE_URL || '').replace(/\/$/, '');
const RAIL = process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : '';
const base = (req) => BASE_ENV || RAIL || `${req.protocol}://${req.get('host')}`;

function setSess(req, res, id) {
  const t = jwt.sign({ id }, SECRET, { expiresIn: '30d' });
  res.cookie('sx', t, { httpOnly: true, sameSite: 'lax', secure: req.protocol === 'https', maxAge: 30 * 864e5 });
}
function auth(req, res, next) {
  try {
    const p = jwt.verify(req.cookies.sx || '', SECRET);
    const u = db.prepare('select * from users where id=?').get(p.id);
    if (!u) throw new Error('no user');
    req.user = u;
    next();
  } catch { res.status(401).json({ error: 'Iniciá sesión con Discord' }); }
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
  const u = new URL('https://discord.com/oauth2/authorize');
  u.search = new URLSearchParams({ client_id: CID, response_type: 'code', redirect_uri: `${base(req)}/auth/discord/callback`, scope: 'identify', state: st }).toString();
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
    db.prepare('insert into users(discord_id,username,plan,created) values(?,?,?,?) on conflict(discord_id) do update set username=excluded.username')
      .run(d.id, d.username, 'free', Date.now());
    const u = db.prepare('select id from users where discord_id=?').get(d.id);
    setSess(req, res, u.id);
    res.redirect('/');
  } catch (e) { console.error('[oauth]', e); res.redirect('/?e=oauth'); }
});
app.post('/api/logout', (req, res) => { res.clearCookie('sx'); res.json({ ok: 1 }); });

// ---------- API del panel web ----------
app.get('/api/me', auth, (req, res) => {
  const max = C.maxScripts(req.user);
  res.json({
    username: req.user.username, admin: !!req.user.admin, plan: req.user.plan,
    max: max === Infinity ? null : max,
    invite: `https://discord.com/oauth2/authorize?client_id=${CID}&scope=bot+applications.commands&permissions=8`,
  });
});
app.get('/api/scripts', auth, (req, res) => {
  const rows = db.prepare('select id,slug,name,enabled,free,buyer_role_id,hwid_days,runs,created,(select count(*) from lkeys where script_id=scripts.id) keys from scripts where user_id=? order by id desc').all(req.user.id);
  const b = base(req);
  res.json(rows.map((r) => {
    const k = db.prepare('select k from lkeys where script_id=? and blacklisted=0 order by id limit 1').get(r.id);
    const st = C.runStats(r.id);
    return { ...r, loadstring: C.loadstring(r.slug, b, k && k.k), d1: st.d1, d7: st.d7, d30: st.d30 };
  }));
});
app.post('/api/scripts', auth, (req, res) => {
  const { name, content, free } = req.body || {};
  const count = db.prepare('select count(*) c from scripts where user_id=?').get(req.user.id).c;
  if (count >= C.maxScripts(req.user)) return res.status(403).json({ error: `El plan gratis permite ${C.PLAN_MAX} scripts. Pasate a Pro para más.` });
  const limit = req.user.admin ? 100 * 1048576 : 1048576;
  if (typeof content !== 'string' || !content.trim() || Buffer.byteLength(content) > limit) return res.status(400).json({ error: `Script vacío o pesa más de ${req.user.admin ? '100 MB' : '1 MB'}` });
  let slug = C.slugify(name);
  if (slug.length < 3) return res.status(400).json({ error: 'Nombre: 3-24 caracteres, letras, números o guiones' });
  if (C.scriptBySlug(slug)) slug = (slug.slice(0, 19) + '-' + crypto.randomBytes(2).toString('hex')).slice(0, 24);
  db.prepare('insert into scripts(user_id,slug,name,content,free,created) values(?,?,?,?,?,?)').run(req.user.id, slug, String(name || slug).slice(0, 40), content, free ? 1 : 0, Date.now());
  res.json({ ok: 1, slug });
});
app.patch('/api/scripts/:id', auth, ownScript, (req, res) => {
  const b = req.body || {};
  if (typeof b.enabled === 'boolean') db.prepare('update scripts set enabled=? where id=?').run(b.enabled ? 1 : 0, req.script.id);
  if (typeof b.free === 'boolean') db.prepare('update scripts set free=? where id=?').run(b.free ? 1 : 0, req.script.id);
  if (typeof b.buyer_role_id === 'string') db.prepare('update scripts set buyer_role_id=? where id=?').run(/^\d{5,25}$/.test(b.buyer_role_id) ? b.buyer_role_id : null, req.script.id);
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

// ---------- Archivos públicos del loader (v1) ----------
app.get('/s/:slug', (req, res) => {
  const slug = String(req.params.slug).toLowerCase();
  if (!C.scriptBySlug(slug)) return res.status(404).type('text/html').send('<h1>Script no encontrado</h1>');
  res.type('text/html').set('Cache-Control', 'no-store').send(C.landingHtml(slug, base(req)));
});
app.get('/files/v1/loaders/:file', (req, res) => {
  const slug = String(req.params.file).replace(/\.lua$/, '').toLowerCase();
  const s = C.scriptBySlug(slug);
  if (!s) return res.status(404).type('text/plain').send('-- not found');
  if (req.accepts(['html', 'text']) === 'html' && !/Roblox/i.test(req.headers['user-agent'] || '')) return res.redirect(`/s/${slug}`);
  res.type('text/plain').set('Cache-Control', 'no-store').send(C.loaderLua(slug, base(req)));
});
app.get('/files/v1/payload/:slug', (req, res) => {
  const q = req.query;
  const key = String(q.k || ''), hwid = String(q.h || ''), n = String(q.n || '');
  if (!/^\d{1,10}$/.test(n) || !/^[A-Za-z0-9_.-]{1,80}$/.test(hwid) && hwid !== '') return res.status(400).end();
  const buf = C.payload(String(req.params.slug).toLowerCase(), key, hwid, n, req.headers['user-agent']);
  res.type('application/octet-stream').set('Cache-Control', 'no-store').send(buf);
});

app.get('/health', (req, res) => res.json({ ok: true }));
const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, '0.0.0.0', () => console.log('[web] listo en puerto', PORT));
if (process.env.DISCORD_BOT_TOKEN) require('./bot').start();
