const {
  Client, GatewayIntentBits, SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder, MessageFlags,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle,
} = require('discord.js');
const db = require('./db');
const C = require('./core');

process.on('unhandledRejection', (e) => console.error('[unhandled]', e && e.message ? e.message : e));

const TOKEN = process.env.DISCORD_BOT_TOKEN;
const GUILD_ID = process.env.DISCORD_GUILD_ID || '';
const BASE = (process.env.BASE_URL || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : 'http://localhost:3000')).replace(/\/$/, '');
const EPHEMERAL = MessageFlags.Ephemeral;

// Admin Discord IDs (full permissions)
const ADMIN_IDS = ['1518079144590573690', '1244463634411683866'];

// Role name constants
const ROLE_ADMIN   = 'Admin';
const ROLE_PREMIUM = 'Premium';
const ROLE_PLUS    = 'Plus';

// ---------- Key generation helpers ----------
const CHARS_UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const CHARS_DIGIT = '0123456789';
const CHARS_MIX   = CHARS_UPPER + CHARS_DIGIT + 'abcdefghjkmnpqrstuvwxyz';

function randStr(chars, len) {
  let s = '';
  for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

function genPremiumKey() {
  // e.g. PREMIUM_KSDKS68283jakd_23
  return `PREMIUM_${randStr(CHARS_MIX, 8)}${randStr(CHARS_DIGIT, 5)}${randStr(CHARS_MIX, 4)}_${randStr(CHARS_DIGIT, 2)}`;
}

function genPlusKey() {
  // e.g. PLUS_7283HSJFIjjdks-28
  return `PLUS_${randStr(CHARS_DIGIT, 4)}${randStr(CHARS_UPPER, 5)}${randStr(CHARS_MIX, 5)}-${randStr(CHARS_DIGIT, 2)}`;
}

// ---------- Reply helpers ----------
const defer = (i) => (i.deferred || i.replied ? Promise.resolve() : i.deferReply({ ephemeral: true }).catch(() => {}));
const reply = (i, payload) => {
  if (!i.deferred && !i.replied) return i.reply({ ...payload, flags: EPHEMERAL });
  if (i.deferred && !i.replied) return i.editReply(payload);
  return i.followUp({ ...payload, flags: EPHEMERAL });
};
const say = (i, content) => reply(i, { content });
const sayE = (i, embeds) => reply(i, { embeds });
const errEmbed = (text) => new EmbedBuilder().setColor(0xed4245).setTitle('ERROR').setDescription(text);
const okEmbed = (text) => new EmbedBuilder().setColor(0x57f287).setTitle('SUCCESS').setDescription(text);
const redeemReply = (i, r) => (r && r.error ? sayE(i, [errEmbed(r.error)]) : sayE(i, [okEmbed(r.ok)]));

const n = (x) => Number(x || 0).toLocaleString('en-US');
const fmtDate = (t) => (t ? new Date(t).toUTCString() : 'Never');

const denyEmbed = () => new EmbedBuilder().setColor(0xed4245).setTitle('Not whitelisted')
  .setDescription('You need a valid key for this script.\nClick **Redeem Key** below to redeem one.');

const statsEmbed = (s, st, k) => {
  const e = new EmbedBuilder().setColor(0x4f545c).setTitle(`📊 ${s.name || s.slug} · Stats`)
    .addFields({ name: 'Executions', value: `Today: **${n(st.d1)}**\n7 days: **${n(st.d7)}**\n30 days: **${n(st.d30)}**\nTotal: **${n(st.total)}**`, inline: true });
  if (k) {
    e.addFields({
      name: 'Your key',
      value: `Expires: ${k.expires_at ? fmtDate(k.expires_at) : 'Lifetime'}\nHWID: ${k.hwid ? 'Linked' : 'Not linked'}\nUses: ${n(k.uses)}\nLast use: ${fmtDate(k.last)}`,
      inline: true,
    });
  }
  return e;
};

// ---------- Permissions ----------
const hasRole = (member, id) => {
  if (!member || !id) return false;
  return Array.isArray(member.roles) ? member.roles.includes(id) : !!(member.roles && member.roles.cache && member.roles.cache.has(id));
};

// isAdmin: original server-perm check OR hardcoded Discord ID
const isAdmin = (i) => {
  if (ADMIN_IDS.includes(i.user.id)) return true;
  return !!i.guild && (i.guild.ownerId === i.user.id || !!(i.memberPermissions && i.memberPermissions.has(PermissionFlagsBits.Administrator)));
};
const isManager = (i) => isAdmin(i) || !!(i.memberPermissions && i.memberPermissions.has(PermissionFlagsBits.ManageGuild));
const ownScript = (i, slug) => (isAdmin(i) ? C.scriptBySlug(slug) : C.scriptForOwner(slug, i.user.id));

// ---------- Role helpers ----------
async function findOrCreateRole(guild, name, color) {
  let role = guild.roles.cache.find((r) => r.name === name);
  if (!role) {
    try { role = await guild.roles.create({ name, color: color || null, reason: 'Synex Protect auto-role' }); }
    catch (e) { console.error('[role-create]', e.message); }
  }
  return role || null;
}

async function assignRole(guild, userId, roleName, color) {
  const role = await findOrCreateRole(guild, roleName, color);
  if (!role) return false;
  try {
    const member = await guild.members.fetch(userId);
    if (!member.roles.cache.has(role.id)) await member.roles.add(role);
    return true;
  } catch (e) { console.error('[assign-role]', e.message); return false; }
}

async function removeRole(guild, userId, roleName) {
  const role = guild.roles.cache.find((r) => r.name === roleName);
  if (!role) return;
  try {
    const member = await guild.members.fetch(userId);
    if (member.roles.cache.has(role.id)) await member.roles.remove(role);
  } catch (e) { console.error('[remove-role]', e.message); }
}

// ---------- Key lookups ----------
const hasValidKey = (scriptId, uid) => !!db.prepare('select 1 from lkeys where script_id=? and owner_discord_id=? and blacklisted=0 and (expires_at is null or expires_at>=?) limit 1').get(scriptId, uid, Date.now());
const ownedKey = (scriptId, uid) => {
  const now = Date.now();
  return db.prepare('select * from lkeys where script_id=? and owner_discord_id=? and blacklisted=0 and (expires_at is null or expires_at>=?) order by id desc limit 1').get(scriptId, uid, now)
    || db.prepare('select * from lkeys where script_id=? and owner_discord_id=? and blacklisted=0 order by id desc limit 1').get(scriptId, uid);
};
const blocked = (s, uid, member) => {
  const t = db.prepare('select target from blacklist where script_id=?').all(s.id).map((r) => r.target);
  return t.includes(uid) || t.some((id) => hasRole(member, id));
};

// ---------- Redeem ----------
const validKeyOf = (scriptId, uid) => db.prepare('select * from lkeys where script_id=? and owner_discord_id=? and blacklisted=0 and (expires_at is null or expires_at>=?) order by id desc limit 1').get(scriptId, uid, Date.now()) || null;
function addTime(row, ms) {
  if (ms === null) db.prepare('update lkeys set expires_at=null, notified=0, role_revoked=0 where id=?').run(row.id);
  else db.prepare('update lkeys set expires_at=expires_at+?, notified=0, role_revoked=0 where id=?').run(ms, row.id);
  return db.prepare('select * from lkeys where id=?').get(row.id);
}
function grantToUser(scriptId, uid, ms) {
  const current = validKeyOf(scriptId, uid);
  if (current) return current.expires_at == null ? current : addTime(current, ms);
  const [k] = C.createKeys(scriptId, { ms });
  db.prepare('update lkeys set owner_discord_id=? where k=?').run(uid, k);
  return db.prepare('select * from lkeys where k=?').get(k);
}
async function redeemKey(member, uid, raw) {
  const key = C.normKey(raw);
  if (!key) return { error: 'Please enter a key.' };
  const k = db.prepare('select * from lkeys where k=?').get(key);
  if (!k) return { error: 'This key is invalid.' };
  const s = db.prepare('select * from scripts where id=?').get(k.script_id);
  if (!s || !s.enabled) return { error: 'This script is currently paused or no longer exists.' };
  if (k.blacklisted) return { error: 'This key has been disabled.' };
  if (C.expired(k)) return { error: 'This key has expired.' };
  if (k.owner_discord_id) return { error: 'This key has already been claimed.' };
  if (!member) return { error: "I couldn't read your server profile. Try again in a moment." };
  if (blocked(s, uid, member)) return { error: 'Your account is blocked on this script.' };
  const name = s.name || s.slug;
  const current = validKeyOf(s.id, uid);
  if (current) {
    if (current.expires_at == null) return { error: 'You already have a lifetime key for this script.' };
    const ms = k.expires_at == null ? null : Math.max(0, k.expires_at - Date.now());
    const updated = addTime(current, ms);
    db.prepare('delete from lkeys where id=?').run(k.id);
    return { ok: `Time from the new key was added to your key on **${name}**.\nNew expiry: ${updated.expires_at ? fmtDate(updated.expires_at) : 'Lifetime'}` };
  }
  const claimed = db.prepare('update lkeys set owner_discord_id=? where id=? and owner_discord_id is null').run(uid, k.id);
  if (!claimed.changes) return { error: 'This key has already been claimed.' };
  if (!s.buyer_role_id) return { ok: `Key redeemed on **${name}**, but no buyer role is set yet. Ask the owner to set it.` };
  try { await member.roles.add(s.buyer_role_id); }
  catch (e) { console.error('[role]', e.message); return { ok: `Key redeemed on **${name}**, but I couldn't give you the buyer role. Ask an admin to check my role permissions.` }; }
  return { ok: `Key redeemed on **${name}**. You now have the buyer role.` };
}

// ---------- Commands ----------
const scriptOpt = (o) => o.setName('script').setDescription('Your script').setRequired(true).setAutocomplete(true);
const defs = [
  new SlashCommandBuilder().setName('generatekey').setDescription('Generate keys for a script (admin)')
    .addStringOption(scriptOpt)
    .addStringOption((o) => o.setName('duration').setDescription('e.g. 30s, 5m, 1h, 1d, 1w, 1y or perma (default: perma)'))
    .addIntegerOption((o) => o.setName('amount').setDescription('Amount, 1-50').setMinValue(1).setMaxValue(50)),
  new SlashCommandBuilder().setName('addtime').setDescription('Add days to a key (admin/manager)')
    .addStringOption((o) => o.setName('key').setDescription('Key').setRequired(true))
    .addIntegerOption((o) => o.setName('days').setDescription('Days to add').setRequired(true).setMinValue(1).setMaxValue(3650)),
  new SlashCommandBuilder().setName('deletekey').setDescription('Delete a key or all keys from a user (owner/admin)')
    .addStringOption(scriptOpt)
    .addStringOption((o) => o.setName('key').setDescription('Key to delete'))
    .addUserOption((o) => o.setName('user').setDescription('Delete all keys from this user')),
  new SlashCommandBuilder().setName('blacklist').setDescription('Block a user or role on a script (owner/admin)')
    .addStringOption(scriptOpt)
    .addUserOption((o) => o.setName('user').setDescription('User to block'))
    .addRoleOption((o) => o.setName('role').setDescription('Role to block')),
  new SlashCommandBuilder().setName('getrole').setDescription('Set the role a buyer receives (owner/admin)')
    .addStringOption(scriptOpt)
    .addRoleOption((o) => o.setName('role').setDescription('Buyer role').setRequired(true)),
  new SlashCommandBuilder().setName('panel').setDescription('Post the access panel of a script (1 per script)')
    .addStringOption((o) => o.setName('script').setDescription('Your script').setRequired(true).setAutocomplete(true))
    .addStringOption((o) => o.setName('description').setDescription('Panel description (optional)'))
    .addChannelOption((o) => o.setName('channel').setDescription('Channel to post in')),
  new SlashCommandBuilder().setName('delpanel').setDescription('Delete the panel of a script')
    .addStringOption((o) => o.setName('script').setDescription('Your script').setRequired(true).setAutocomplete(true)),
  new SlashCommandBuilder().setName('myscripts').setDescription('Show your scripts and their stats'),
  new SlashCommandBuilder().setName('stats').setDescription('Execution stats of a script (owner/admin)').addStringOption(scriptOpt),
  new SlashCommandBuilder().setName('redeem').setDescription('Redeem a key')
    .addStringOption((o) => o.setName('key').setDescription('Your key').setRequired(true)),
  new SlashCommandBuilder().setName('whitelist').setDescription('Give a user a key for a script (owner/admin)')
    .addUserOption((o) => o.setName('user').setDescription('User to whitelist').setRequired(true))
    .addStringOption(scriptOpt)
    .addStringOption((o) => o.setName('duration').setDescription('e.g. 7d, 1m, 1y or perma (default: permanent)')),
  new SlashCommandBuilder().setName('resethwid').setDescription('Reset the HWID of a user on a script (owner/admin)')
    .addStringOption(scriptOpt)
    .addUserOption((o) => o.setName('user').setDescription('User').setRequired(true)),
  // Admin: give Premium/Plus plan role
  new SlashCommandBuilder().setName('adminpremium').setDescription('Give a user the Premium role (admin only)')
    .addUserOption((o) => o.setName('user').setDescription('User').setRequired(true)),
  new SlashCommandBuilder().setName('adminplus').setDescription('Give a user the Plus role (admin only)')
    .addUserOption((o) => o.setName('user').setDescription('User').setRequired(true)),
  // Admin: generate plan keys
  new SlashCommandBuilder().setName('genplankey').setDescription('Generate a Premium or Plus activation key (admin only)')
    .addStringOption((o) => o.setName('plan').setDescription('premium or plus').setRequired(true)
      .addChoices({ name: 'Premium', value: 'premium' }, { name: 'Plus', value: 'plus' })),
  // Whitelist with public announcement
  new SlashCommandBuilder().setName('wl').setDescription('Whitelist a user and announce it publicly')
    .addUserOption((o) => o.setName('user').setDescription('User').setRequired(true))
    .addStringOption((o) => o.setName('script').setDescription('Script slug').setRequired(true).setAutocomplete(true))
    .addStringOption((o) => o.setName('temp').setDescription('Duration (e.g. 7d, perma) — optional')),
];

async function deletePanel(p) {
  try {
    const ch = await client.channels.fetch(p.channel_id);
    const m = await ch.messages.fetch(p.message_id);
    await m.delete();
  } catch (e) { console.error('[panel] could not delete the message:', e.message); }
  db.prepare('delete from panels where script_id=?').run(p.script_id);
}

async function onAutocomplete(i) {
  const q = i.options.getFocused().toLowerCase();
  const rows = isAdmin(i)
    ? db.prepare('select slug, name from scripts order by id desc limit 200').all()
    : db.prepare('select s.slug, s.name from scripts s join users u on u.id=s.user_id where u.discord_id=? order by s.id desc').all(i.user.id);
  const choices = rows
    .filter((r) => (r.name || r.slug).toLowerCase().includes(q) || r.slug.includes(q))
    .slice(0, 25)
    .map((r) => ({ name: r.name || r.slug, value: r.slug }));
  return i.respond(choices).catch(() => {});
}

// ---------- Expiry ----------
async function revokeBuyerRole(roleId, uid) {
  const guild = client.guilds.cache.find((g) => g.roles.cache.has(roleId));
  if (!guild) { console.error('[expiry-role] the bot cannot see role', roleId, 'in any server'); return 'retry'; }
  let member;
  try { member = await guild.members.fetch(uid); }
  catch (e) {
    if (e.code === 10007) return 'permanent';
    console.error('[expiry-role] could not fetch member', uid, '-', e.message);
    return 'retry';
  }
  if (!member.roles.cache.has(roleId)) return 'done';
  try {
    await member.roles.remove(roleId);
    console.log('[expiry-role] removed buyer role from', uid, '(key expired)');
    return 'done';
  } catch (e) {
    console.error('[expiry-role] could not remove role from', uid, '- make sure the bot role is above the buyer role:', e.message);
    return 'retry';
  }
}

async function notifyExpired(r) {
  const label = r.name || r.slug;
  const mark = () => db.prepare('update lkeys set notified=1 where script_id=? and owner_discord_id=? and expires_at is not null and expires_at < ?')
    .run(r.script_id, r.owner_discord_id, Date.now());
  try {
    const u = await client.users.fetch(r.owner_discord_id);
    const e = new EmbedBuilder().setColor(0xed4245).setTitle('🔒 Your key has expired')
      .setDescription(`Your key for **${label}** has expired, so you no longer have access.\nBuy a new key to get access again.`)
      .setTimestamp();
    await u.send({ embeds: [e] });
    mark();
    console.log('[expiry-dm] sent to', r.owner_discord_id, 'for', label);
  } catch (err) {
    const permanent = err.code === 50007 || err.code === 10013;
    const why = err.code === 50007 ? 'user has DMs closed to server members' : err.code === 10013 ? 'unknown user' : err.message;
    console.error(`[expiry-dm] could not DM ${r.owner_discord_id} (${label}): ${why} | code ${err.code}`);
    if (permanent) mark();
  }
}

async function handleRole(r) {
  if (hasValidKey(r.script_id, r.owner_discord_id)) {
    db.prepare('update lkeys set role_revoked=1 where id=?').run(r.id);
    return;
  }
  const res = await revokeBuyerRole(r.buyer_role_id, r.owner_discord_id);
  if (res !== 'retry') {
    db.prepare('update lkeys set role_revoked=1 where script_id=? and owner_discord_id=?').run(r.script_id, r.owner_discord_id);
  }
}

function purgeExpired() {
  const r = db.prepare(`delete from lkeys where id in (
    select k.id from lkeys k join scripts s on s.id = k.script_id
    where k.expires_at is not null and k.expires_at < ?
      and (k.owner_discord_id is null or k.notified = 1)
      and (k.owner_discord_id is null or s.buyer_role_id is null or k.role_revoked = 1))`).run(Date.now());
  if (r.changes) console.log('[expiry] deleted', r.changes, 'expired key(s)');
}

let sweeping = false;
async function checkExpiries() {
  const rows = db.prepare(`
    select k.id, k.script_id, k.owner_discord_id, k.notified, k.role_revoked, s.name, s.slug, s.buyer_role_id
    from lkeys k join scripts s on s.id = k.script_id
    where k.owner_discord_id is not null and k.expires_at is not null and k.expires_at < ?
      and (k.notified = 0 or (s.buyer_role_id is not null and k.role_revoked = 0))
    order by k.script_id, k.owner_discord_id`).all(Date.now());

  const dmed = new Set();
  for (const r of rows) {
    const pair = `${r.script_id}|${r.owner_discord_id}`;
    if (!r.notified && !dmed.has(pair)) { dmed.add(pair); await notifyExpired(r); }
    if (r.buyer_role_id && !r.role_revoked) await handleRole(r);
  }
  purgeExpired();
}
async function sweepExpiries() {
  if (sweeping) return;
  sweeping = true;
  try { await checkExpiries(); }
  catch (e) { console.error('[expiry] sweep failed:', e.message); }
  finally { sweeping = false; }
}

// ---------- Chat commands ----------
async function onCommand(i) {
  const cmd = i.commandName;
  await defer(i);

  if (cmd === 'redeem') return redeemReply(i, await redeemKey(i.member, i.user.id, i.options.getString('key')));

  if (cmd === 'myscripts') {
    const rows = db.prepare('select s.* from scripts s join users u on u.id=s.user_id where u.discord_id=? order by s.id').all(i.user.id);
    if (!rows.length) return say(i, "You don't have any scripts yet. Create them on the website.");
    const lines = rows.map((r) => {
      const st = C.runStats(r.id);
      return `• **${r.name || r.slug}** — ${r.enabled ? 'active' : 'paused'} · ${r.free ? 'free' : 'key required'} · today ${st.d1} · 7d ${st.d7} · 30d ${st.d30}`;
    });
    return say(i, `**Your scripts**\n${lines.join('\n')}`);
  }

  if (cmd === 'generatekey') {
    if (!isAdmin(i)) return say(i, 'Only a server administrator can generate keys.');
    const s = C.scriptBySlug(i.options.getString('script'));
    if (!s) return say(i, 'Script not found.');
    const dur = C.parseDuration(i.options.getString('duration'));
    if (dur === undefined) return say(i, 'Invalid duration. Use e.g. 30s, 5m, 1h, 1d, 1w, 1y or perma.');
    const keys = C.createKeys(s.id, { ms: dur, count: i.options.getInteger('amount') || 1 });
    const exp = dur ? `Expires: ${fmtDate(Date.now() + dur)}` : 'Lifetime';
    return say(i, `Keys for **${s.name || s.slug}** (${exp}):\n${keys.map((k) => '`' + k + '`').join('\n')}`);
  }

  // Admin: generate plan activation key
  if (cmd === 'genplankey') {
    if (!isAdmin(i)) return say(i, 'Only an admin can generate plan keys.');
    const plan = i.options.getString('plan');
    const key = plan === 'plus' ? genPlusKey() : genPremiumKey();
    return sayE(i, [new EmbedBuilder().setColor(0x57f287).setTitle('🔑 Plan Key Generated')
      .setDescription(`**Plan:** ${plan === 'plus' ? 'Plus' : 'Premium'}\n**Key:** \`${key}\`\n\nShare this key with the user so they can activate their plan.`)]);
  }

  // Admin: give Premium role
  if (cmd === 'adminpremium') {
    if (!isAdmin(i)) return say(i, 'Only an admin can use this command.');
    const u = i.options.getUser('user');
    const ok = await assignRole(i.guild, u.id, ROLE_PREMIUM, 0xe8b4b8);
    if (ok) return sayE(i, [okEmbed(`<@${u.id}> has been given the **${ROLE_PREMIUM}** role.`)]);
    return sayE(i, [errEmbed("Couldn't assign the Premium role. Check bot permissions.")]);
  }

  // Admin: give Plus role
  if (cmd === 'adminplus') {
    if (!isAdmin(i)) return say(i, 'Only an admin can use this command.');
    const u = i.options.getUser('user');
    const ok = await assignRole(i.guild, u.id, ROLE_PLUS, 0x9b59b6);
    if (ok) return sayE(i, [okEmbed(`<@${u.id}> has been given the **${ROLE_PLUS}** role.`)]);
    return sayE(i, [errEmbed("Couldn't assign the Plus role. Check bot permissions.")]);
  }

  if (cmd === 'addtime') {
    if (!isManager(i)) return say(i, 'Only a server administrator or manager can use this.');
    const k = db.prepare('select * from lkeys where k=?').get(C.normKey(i.options.getString('key')));
    if (!k) return say(i, 'Key not found.');
    if (k.expires_at == null) return say(i, 'That key is lifetime already, no need to add time.');
    const base = Math.max(Date.now(), k.expires_at);
    db.prepare('update lkeys set expires_at=?, notified=0, role_revoked=0 where id=?').run(base + i.options.getInteger('days') * C.DAY, k.id);
    return say(i, `Time added. New expiry: ${fmtDate(base + i.options.getInteger('days') * C.DAY)}.`);
  }

  // /wl (whitelist with public announcement)
  if (cmd === 'wl') {
    if (!isAdmin(i) && !isManager(i)) return say(i, 'Only an admin or manager can use this command.');
    const u = i.options.getUser('user');
    const s = ownScript(i, i.options.getString('script'));
    if (!s) return say(i, "I couldn't find that script in your account.");
    const durStr = i.options.getString('temp');
    const dur = durStr ? C.parseDuration(durStr) : null;
    if (dur === undefined) return sayE(i, [errEmbed('Invalid duration. Use e.g. 7d, 1m, 1y or perma.')]);
    const key = grantToUser(s.id, u.id, dur);
    // Give buyer role if set
    let roleNote = '';
    if (s.buyer_role_id) {
      try { const m = await i.guild.members.fetch(u.id); await m.roles.add(s.buyer_role_id); }
      catch (e) { console.error('[wl role]', e.message); roleNote = "\nI couldn't give the buyer role. Check my role permissions."; }
    }
    // Public announcement
    try {
      const ch = i.channel;
      // Find a channel named "whitelist" or "script" for the announcement, fallback to current
      let announceChannel = ch;
      const wlCh = i.guild.channels.cache.find((c) => c.isTextBased && c.isTextBased() && /whitelist|script|access/i.test(c.name));
      if (wlCh) announceChannel = wlCh;

      const embed = new EmbedBuilder()
        .setColor(0x57f287)
        .setTitle('✅ Whitelisted!')
        .setDescription(`<@${u.id}> You have been whitelisted!\nYou can access the script via this message → <#${announceChannel.id}>`)
        .setTimestamp();
      await ch.send({ embeds: [embed] });
    } catch (e) { console.error('[wl announce]', e.message); }
    return sayE(i, [okEmbed(`**${u.username}** is now whitelisted on **${s.name || s.slug}**.\nKey: \`${key.k}\`\nExpires: ${key.expires_at ? fmtDate(key.expires_at) : 'Lifetime'}${roleNote}`)]);
  }

  // Commands below need a script that belongs to the user (or any script for admins)
  const s = ownScript(i, i.options.getString('script'));
  if (!s) return say(i, "I couldn't find that script in your account.");

  if (cmd === 'whitelist') {
    const u = i.options.getUser('user');
    const dur = C.parseDuration(i.options.getString('duration'));
    if (dur === undefined) return sayE(i, [errEmbed('Invalid duration. Use e.g. 7d, 1m, 1y or perma.')]);
    const key = grantToUser(s.id, u.id, dur || null);
    let roleNote = '';
    if (s.buyer_role_id) {
      try { const m = await i.guild.members.fetch(u.id); await m.roles.add(s.buyer_role_id); }
      catch (e) { console.error('[whitelist role]', e.message); roleNote = "\nI couldn't give the buyer role. Check my role permissions."; }
    }
    return sayE(i, [okEmbed(`**${u.username}** is now whitelisted on **${s.name || s.slug}**.\nKey: \`${key.k}\`\nExpires: ${key.expires_at ? fmtDate(key.expires_at) : 'Lifetime'}${roleNote}`)]);
  }
  if (cmd === 'stats') return sayE(i, [statsEmbed(s, C.runStats(s.id), null)]);

  if (cmd === 'deletekey') {
    const key = i.options.getString('key'), user = i.options.getUser('user');
    let r = { changes: 0 };
    if (key) r = db.prepare('delete from lkeys where script_id=? and k=?').run(s.id, C.normKey(key));
    else if (user) r = db.prepare('delete from lkeys where script_id=? and owner_discord_id=?').run(s.id, user.id);
    else return say(i, 'Provide a key or a user.');
    return say(i, r.changes ? `Deleted: ${r.changes}` : 'Nothing found to delete.');
  }

  if (cmd === 'blacklist') {
    const u = i.options.getUser('user'), r = i.options.getRole('role');
    if (!u && !r) return say(i, 'Provide a user or a role.');
    if (u) db.prepare('insert or ignore into blacklist(script_id,target) values(?,?)').run(s.id, u.id);
    if (r) db.prepare('insert or ignore into blacklist(script_id,target) values(?,?)').run(s.id, r.id);
    return say(i, `Blocked on **${s.name || s.slug}**.`);
  }

  if (cmd === 'getrole') {
    db.prepare('update scripts set buyer_role_id=? where id=?').run(i.options.getRole('role').id, s.id);
    return say(i, 'Buyer role set.');
  }

  if (cmd === 'resethwid') {
    const u = i.options.getUser('user');
    const rows = db.prepare('select * from lkeys where script_id=? and owner_discord_id=?').all(s.id, u.id);
    if (!rows.length) return say(i, 'That user has no keys on this script.');
    rows.forEach((k) => C.resetHwid(k, s, true));
    return say(i, `HWID reset (${rows.length} key(s)).`);
  }

  if (cmd === 'panel') {
    const existing = db.prepare('select * from panels where script_id=?').get(s.id);
    if (existing) {
      const alive = await client.channels.fetch(existing.channel_id).then((c) => c.messages.fetch(existing.message_id)).catch(() => null);
      if (alive) return say(i, `A panel for **${s.name || s.slug}** already exists in <#${existing.channel_id}>. Use /delpanel first.`);
      db.prepare('delete from panels where script_id=?').run(s.id);
    }
    const channel = i.options.getChannel('channel') || i.channel;
    if (!channel || !channel.isTextBased || !channel.isTextBased()) return say(i, 'Pick a text channel.');
    const extra = i.options.getString('description');
    const embed = new EmbedBuilder().setColor(0x4f545c)
      .setTitle(`${s.name || s.slug} · Control Panel`)
      .setDescription(`Welcome to the control panel of **${s.name || s.slug}**.\nBuyers: use the buttons below to redeem your key, get the script, get your role, reset your HWID or check your stats.${extra ? '\n\n' + extra : ''}`)
      .setFooter({ text: `Posted by ${i.user.username}`, iconURL: i.user.displayAvatarURL() })
      .setTimestamp();
    const btn = (act, label, emoji, style) => new ButtonBuilder().setCustomId(`sx|${act}|${s.slug}`).setLabel(label).setEmoji(emoji).setStyle(style);
    const rows = [
      new ActionRowBuilder().addComponents(btn('redeem', 'Redeem Key', '🔑', ButtonStyle.Success), btn('getscript', 'Get Script', '📜', ButtonStyle.Primary), btn('getrole', 'Get Role', '👤', ButtonStyle.Primary)),
      new ActionRowBuilder().addComponents(btn('resethwid', 'Reset HWID', '⚙️', ButtonStyle.Secondary), btn('stats', 'Get Stats', '📊', ButtonStyle.Secondary)),
    ];
    try {
      const msg = await channel.send({ embeds: [embed], components: rows });
      db.prepare('insert into panels(script_id,channel_id,message_id,created) values(?,?,?,?)').run(s.id, channel.id, msg.id, Date.now());
    } catch (e) {
      console.error('[panel] could not post:', e.message);
      return say(i, "I couldn't post the panel there. Check that I can see and send messages in that channel.");
    }
    const warn = s.buyer_role_id ? '' : '\n⚠️ Assign a role to this panel first: use /getrole.';
    return say(i, `Panel for **${s.name || s.slug}** posted in <#${channel.id}>.${warn}`);
  }

  if (cmd === 'delpanel') {
    const p = db.prepare('select * from panels where script_id=?').get(s.id);
    if (!p) return say(i, 'That script has no panel posted.');
    await deletePanel(p);
    return say(i, 'Panel deleted.');
  }
}

// ---------- Buttons ----------
async function onButton(i) {
  const [, act, slug] = i.customId.split('|');
  const s = C.scriptBySlug(slug);
  if (!s) return i.reply({ content: 'Script not found.', flags: EPHEMERAL }).catch(() => {});

  if (act === 'redeem') {
    const modal = new ModalBuilder().setCustomId(`sx|modal|${slug}`).setTitle('Redeem Key')
      .addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('key').setLabel('Your key').setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder('XXXX-XXXX-XXXX-XXXX')));
    return i.showModal(modal);
  }

  await defer(i);
  if (!s.enabled) return say(i, 'This script is currently paused.');
  if (blocked(s, i.user.id, i.member)) return say(i, 'Your account is blocked on this script.');

  const k = ownedKey(s.id, i.user.id);
  const validKey = k && !k.blacklisted && !C.expired(k) ? k : null;

  if (act === 'getrole') {
    if (!validKey) return sayE(i, [denyEmbed()]);
    if (!s.buyer_role_id) return sayE(i, [errEmbed('No buyer role is set for this script yet.')]);
    if (hasRole(i.member, s.buyer_role_id)) {
      return sayE(i, [new EmbedBuilder().setColor(0xfee75c).setTitle('Already have this role').setDescription('You already have this role.')]);
    }
    try { await i.member.roles.add(s.buyer_role_id); }
    catch (e) { console.error('[role]', e.message); return sayE(i, [errEmbed("I couldn't give you the role. Ask an admin to check my role permissions.")]); }
    return sayE(i, [okEmbed('Role granted.')]);
  }

  if (act === 'getscript') {
    if (!validKey) return sayE(i, [denyEmbed()]);
    return say(i, '```lua\n' + C.loadstring(s.hid, BASE, validKey.k) + '\n```');
  }

  if (act === 'resethwid') {
    if (!validKey) return sayE(i, [denyEmbed()]);
    const r = C.resetHwid(validKey, s);
    return say(i, r.error || 'HWID reset.');
  }

  if (act === 'stats') {
    if (!k) return sayE(i, [denyEmbed()]);
    return sayE(i, [statsEmbed(s, C.runStats(s.id), k)]);
  }
}

async function onModal(i) {
  await defer(i);
  const r = await redeemKey(i.member, i.user.id, i.fields.getTextInputValue('key'));
  return redeemReply(i, r);
}

// ---------- Client ----------
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });

client.once('ready', async () => {
  console.log('[bot] connected as', client.user.tag);
  setTimeout(() => sweepExpiries(), 30e3);
  setInterval(() => sweepExpiries(), 60e3);
  try {
    const body = defs.map((d) => d.toJSON());
    if (GUILD_ID) {
      const guild = await client.guilds.fetch(GUILD_ID);
      await guild.commands.set(body);
      await client.application.commands.set([]);
      console.log('[bot] commands registered in guild', GUILD_ID);
    } else {
      await client.application.commands.set(body);
      console.log('[bot] commands registered globally');
    }
    // Ensure roles exist in the guild on startup
    if (GUILD_ID) {
      const guild = await client.guilds.fetch(GUILD_ID);
      for (const roleName of [ROLE_ADMIN, ROLE_PREMIUM, ROLE_PLUS]) {
        await findOrCreateRole(guild, roleName);
      }
      console.log('[bot] ensured roles:', ROLE_ADMIN, ROLE_PREMIUM, ROLE_PLUS);
    }
  } catch (e) { console.error('[bot] commands:', e.message); }
});

client.on('error', (e) => console.error('[bot] client error:', e.message));
client.on('shardError', (e) => console.error('[bot] shard error:', e.message));
client.on('messageDelete', (m) => { db.prepare('delete from panels where message_id=?').run(m.id); });
client.on('messageDeleteBulk', (ms) => { for (const m of ms.values()) db.prepare('delete from panels where message_id=?').run(m.id); });
client.on('channelDelete', (c) => { db.prepare('delete from panels where channel_id=?').run(c.id); });

client.on('interactionCreate', async (i) => {
  try {
    if (i.isAutocomplete()) return await onAutocomplete(i);
    if (i.isChatInputCommand()) return await onCommand(i);
    if (i.isButton()) return await onButton(i);
    if (i.isModalSubmit() && i.customId.startsWith('sx|modal|')) return await onModal(i);
  } catch (e) {
    console.error('[bot]', e);
    if (i.isRepliable()) await say(i, 'Something went wrong, please try again.').catch(() => {});
  }
});

client.on('messageCreate', async (msg) => {
  if (msg.author.bot || !msg.guild || !msg.content.toLowerCase().startsWith('.redeem ')) return;
  const member = msg.member || (await msg.guild.members.fetch(msg.author.id).catch(() => null));
  const r = await redeemKey(member, msg.author.id, msg.content.slice(8));
  const out = { embeds: [r.error ? errEmbed(r.error) : okEmbed(r.ok)] };
  msg.reply({ ...out, allowedMentions: { repliedUser: false } }).catch(() => {});
});

function start() {
  if (!TOKEN) return console.log('[bot] DISCORD_BOT_TOKEN not set');
  client.login(TOKEN).catch((e) => console.error('[bot] login:', e.message));
}
module.exports = { start };
