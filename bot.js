const {
  Client, GatewayIntentBits, SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle,
} = require('discord.js');
const db = require('./db');
const C = require('./core');

const TOKEN = process.env.DISCORD_BOT_TOKEN;
const BASE = (process.env.BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const ephemeral = { flags: 64 };
const say = (i, content) => (i.deferred || i.replied ? i.followUp({ content, ...ephemeral }) : i.reply({ content, ...ephemeral }));

const hasRole = (member, id) => {
  if (!member || !id) return false;
  return Array.isArray(member.roles) ? member.roles.includes(id) : !!(member.roles && member.roles.cache && member.roles.cache.has(id));
};
// Admin = permiso Administrador en el servidor (o ser dueño del servidor). Gestor = Gestionar servidor.
const isAdmin = (i) => !!i.guild && (i.guild.ownerId === i.user.id || !!(i.memberPermissions && i.memberPermissions.has(PermissionFlagsBits.Administrator)));
const isManager = (i) => isAdmin(i) || !!(i.memberPermissions && i.memberPermissions.has(PermissionFlagsBits.ManageGuild));
const ownScript = (i, slug) => (isAdmin(i) ? C.scriptBySlug(slug) : C.scriptForOwner(slug, i.user.id));
const ownedKey = (scriptId, uid) => db.prepare('select * from lkeys where script_id=? and owner_discord_id=? and blacklisted=0 order by id limit 1').get(scriptId, uid);
const isBuyer = (member, s) => !!s.buyer_role_id && hasRole(member, s.buyer_role_id);
const blocked = (s, uid, member) => {
  const t = db.prepare('select target from blacklist where script_id=?').all(s.id).map((r) => r.target);
  return t.includes(uid) || t.some((id) => hasRole(member, id));
};

async function redeemKey(member, uid, raw) {
  const k = db.prepare('select * from lkeys where k=?').get(String(raw || '').trim());
  if (!k) return 'Key inválida.';
  const s = db.prepare('select * from scripts where id=?').get(k.script_id);
  if (!s || !s.enabled) return 'El script está pausado o no existe.';
  if (k.owner_discord_id && k.owner_discord_id !== uid) return 'Esa key ya fue canjeada por otra cuenta.';
  if (k.blacklisted || C.expired(k)) return 'Key vencida o desactivada.';
  if (blocked(s, uid, member)) return 'Tu cuenta está bloqueada en este script.';
  db.prepare('update lkeys set owner_discord_id=? where id=?').run(uid, k.id);
  if (s.buyer_role_id && member && member.roles && member.roles.add) {
    try { await member.roles.add(s.buyer_role_id); } catch (e) { console.error('[role]', e.message); }
  }
  return `Key canjeada en **${s.slug}**. Ya podés usar los botones del panel.`;
}

const scriptOpt = (o) => o.setName('script').setDescription('Slug del script').setRequired(true);
const defs = [
  new SlashCommandBuilder().setName('generatekey').setDescription('Genera keys para un script (admin)')
    .addStringOption(scriptOpt)
    .addIntegerOption((o) => o.setName('days').setDescription('Días de validez (vacío = de por vida)').setMinValue(1).setMaxValue(3650))
    .addIntegerOption((o) => o.setName('amount').setDescription('Cantidad 1-50').setMinValue(1).setMaxValue(50)),
  new SlashCommandBuilder().setName('addtime').setDescription('Añade días a una key (admin/gestor)')
    .addStringOption((o) => o.setName('key').setDescription('Key').setRequired(true))
    .addIntegerOption((o) => o.setName('days').setDescription('Días a añadir').setRequired(true).setMinValue(1).setMaxValue(3650)),
  new SlashCommandBuilder().setName('deletekey').setDescription('Elimina una key o las keys de un usuario (creador/gestor)')
    .addStringOption(scriptOpt)
    .addStringOption((o) => o.setName('key').setDescription('Key a borrar'))
    .addUserOption((o) => o.setName('user').setDescription('Borrar todas las keys de este usuario')),
  new SlashCommandBuilder().setName('blacklist').setDescription('Bloquea un usuario o rol en un script (creador/admin)')
    .addStringOption(scriptOpt)
    .addUserOption((o) => o.setName('user').setDescription('Usuario a bloquear'))
    .addRoleOption((o) => o.setName('role').setDescription('Rol a bloquear')),
  new SlashCommandBuilder().setName('getrole').setDescription('Configura el rol que recibe un comprador (creador/admin)')
    .addStringOption(scriptOpt)
    .addRoleOption((o) => o.setName('role').setDescription('Rol de comprador').setRequired(true)),
  new SlashCommandBuilder().setName('panel').setDescription('Publica el panel de acceso de un script (solo 1 por script)')
    .addStringOption((o) => o.setName('script').setDescription('Tu script').setRequired(true).setAutocomplete(true))
    .addStringOption((o) => o.setName('descripcion').setDescription('Descripción del panel (opcional)'))
    .addChannelOption((o) => o.setName('channel').setDescription('Canal donde publicar')),
  new SlashCommandBuilder().setName('delpanel').setDescription('Borra el panel de un script')
    .addStringOption((o) => o.setName('script').setDescription('Tu script').setRequired(true).setAutocomplete(true)),
  new SlashCommandBuilder().setName('myscripts').setDescription('Muestra tus scripts y sus estadísticas'),
  new SlashCommandBuilder().setName('stats').setDescription('Estadísticas de ejecución de un script (creador/admin)').addStringOption(scriptOpt),
  new SlashCommandBuilder().setName('redeem').setDescription('Canjea una key')
    .addStringOption((o) => o.setName('key').setDescription('Tu key').setRequired(true)),
  new SlashCommandBuilder().setName('resterhwid').setDescription('Reinicia el HWID de un usuario en un script (creador/admin)')
    .addStringOption(scriptOpt)
    .addUserOption((o) => o.setName('user').setDescription('Usuario').setRequired(true)),
];

async function deletePanel(p) {
  try {
    const ch = await client.channels.fetch(p.channel_id);
    const m = await ch.messages.fetch(p.message_id);
    await m.delete();
  } catch (e) { console.error('[panel] no pude borrar el mensaje:', e.message); }
  db.prepare('delete from panels where script_id=?').run(p.script_id);
}
function onAutocomplete(i) {
  const q = i.options.getFocused().toLowerCase();
  const rows = isAdmin(i)
    ? db.prepare('select slug from scripts order by id desc limit 200').all()
    : db.prepare('select s.slug from scripts s join users u on u.id=s.user_id where u.discord_id=? order by s.id desc').all(i.user.id);
  return i.respond(rows.filter((r) => r.slug.includes(q)).slice(0, 25).map((r) => ({ name: r.slug, value: r.slug })));
}

async function onCommand(i) {
  const cmd = i.commandName;
  if (cmd === 'redeem') return say(i, await redeemKey(i.member, i.user.id, i.options.getString('key')));
  if (cmd === 'myscripts') {
    const rows = db.prepare('select s.* from scripts s join users u on u.id=s.user_id where u.discord_id=? order by s.id').all(i.user.id);
    if (!rows.length) return say(i, 'No tenés scripts todavía. Creálos en la web.');
    const lines = rows.map((r) => { const st = C.runStats(r.id); return `• **${r.slug}** — ${r.enabled ? 'activo' : 'pausado'} · ${r.free ? 'gratis' : 'con key'} · hoy ${st.d1} · 7d ${st.d7} · 30d ${st.d30}`; });
    return say(i, `**Tus scripts**\n${lines.join('\n')}`);
  }
  if (cmd === 'stats') {
    const s = ownScript(i, i.options.getString('script'));
    if (!s) return say(i, 'No encontré ese script en tu cuenta.');
    const st = C.runStats(s.id);
    return say(i, `**${s.slug}**\nHoy: ${st.d1}\n7 días: ${st.d7}\n30 días: ${st.d30}\nTotal: ${st.total}`);
  }

  if (cmd === 'generatekey') {
    if (!isAdmin(i)) return say(i, 'Solo un administrador del servidor puede generar keys.');
    const s = C.scriptBySlug(i.options.getString('script'));
    if (!s) return say(i, 'Script no encontrado.');
    const keys = C.createKeys(s.id, { days: i.options.getInteger('days'), count: i.options.getInteger('amount') || 1 });
    return say(i, `Keys para **${s.slug}**:\n${keys.map((k) => '`' + k + '`').join('\n')}`);
  }

  if (cmd === 'addtime') {
    if (!isManager(i)) return say(i, 'Solo un administrador o gestor del servidor puede usar esto.');
    const k = db.prepare('select * from lkeys where k=?').get(i.options.getString('key').trim());
    if (!k) return say(i, 'Key no encontrada.');
    const base = Math.max(Date.now(), k.expires_at || 0);
    db.prepare('update lkeys set expires_at=? where id=?').run(base + i.options.getInteger('days') * C.DAY, k.id);
    return say(i, 'Tiempo añadido.');
  }

  const s = ownScript(i, i.options.getString('script'));
  if (!s) return say(i, 'No encontré ese script en tu cuenta.');

  if (cmd === 'deletekey') {
    const key = i.options.getString('key'), user = i.options.getUser('user');
    let r = { changes: 0 };
    if (key) r = db.prepare('delete from lkeys where script_id=? and k=?').run(s.id, key.trim());
    else if (user) r = db.prepare('delete from lkeys where script_id=? and owner_discord_id=?').run(s.id, user.id);
    else return say(i, 'Indicá una key o un usuario.');
    return say(i, r.changes ? `Eliminada(s): ${r.changes}` : 'No encontré nada para borrar.');
  }
  if (cmd === 'blacklist') {
    const u = i.options.getUser('user'), r = i.options.getRole('role');
    if (!u && !r) return say(i, 'Indicá un usuario o un rol.');
    if (u) db.prepare('insert or ignore into blacklist(script_id,target) values(?,?)').run(s.id, u.id);
    if (r) db.prepare('insert or ignore into blacklist(script_id,target) values(?,?)').run(s.id, r.id);
    return say(i, 'Bloqueado en ' + s.slug + '.');
  }
  if (cmd === 'getrole') {
    db.prepare('update scripts set buyer_role_id=? where id=?').run(i.options.getRole('role').id, s.id);
    return say(i, 'Rol de comprador configurado.');
  }
  if (cmd === 'resterhwid') {
    const u = i.options.getUser('user');
    const rows = db.prepare('select * from lkeys where script_id=? and owner_discord_id=?').all(s.id, u.id);
    if (!rows.length) return say(i, 'Ese usuario no tiene keys en este script.');
    rows.forEach((k) => C.resetHwid(k, s, true));
    return say(i, `HWID reiniciado (${rows.length} key/s).`);
  }
  if (cmd === 'panel') {
    const existing = db.prepare('select * from panels where script_id=?').get(s.id);
    if (existing) {
      const alive = await client.channels.fetch(existing.channel_id).then((c) => c.messages.fetch(existing.message_id)).catch(() => null);
      if (alive) return say(i, `Ya existe un panel de **${s.slug}** en <#${existing.channel_id}>. Usá /delpanel para borrarlo primero.`);
      db.prepare('delete from panels where script_id=?').run(s.id);
    }
    const channel = i.options.getChannel('channel') || i.channel;
    if (!channel || !channel.isTextBased || !channel.isTextBased()) return say(i, 'Elegí un canal de texto.');
    const desc = i.options.getString('descripcion') || 'Use the buttons below to redeem your key, get the script or get your role.';
    const embed = new EmbedBuilder().setColor(0x5865f2)
      .setAuthor({ name: 'Synex' })
      .setTitle(`${s.slug} Control Panel`)
      .setDescription(`This control panel is for the project: **${s.slug}**\n${desc}\nIf you're a buyer, click on the buttons below to redeem your key, get the script or get your role.`)
      .setFooter({ text: `Sent by ${i.user.username}`, iconURL: i.user.displayAvatarURL() })
      .setTimestamp();
    const btn = (act, label, emoji, style) => new ButtonBuilder().setCustomId(`sx|${act}|${s.slug}`).setLabel(label).setEmoji(emoji).setStyle(style);
    const rows = [
      new ActionRowBuilder().addComponents(btn('redeem', 'Redeem Key', '🔑', ButtonStyle.Success), btn('getscript', 'Get Script', '📜', ButtonStyle.Primary), btn('getrole', 'Get Role', '👤', ButtonStyle.Primary)),
      new ActionRowBuilder().addComponents(btn('resethwid', 'Reset HWID', '⚙️', ButtonStyle.Secondary), btn('stats', 'Get Stats', '📊', ButtonStyle.Secondary)),
    ];
    const msg = await channel.send({ embeds: [embed], components: rows });
    db.prepare('insert into panels(script_id,channel_id,message_id,created) values(?,?,?,?)').run(s.id, channel.id, msg.id, Date.now());
    return say(i, `Panel de **${s.slug}** publicado en <#${channel.id}>.`);
  }
  if (cmd === 'delpanel') {
    const p = db.prepare('select * from panels where script_id=?').get(s.id);
    if (!p) return say(i, 'Ese script no tiene panel publicado.');
    await deletePanel(p);
    return say(i, 'Panel borrado.');
  }
}

async function onButton(i) {
  const [, act, slug] = i.customId.split('|');
  const s = C.scriptBySlug(slug);
  if (!s) return say(i, 'Script no encontrado.');
  if (act === 'redeem') {
    const modal = new ModalBuilder().setCustomId(`sx|modal|${slug}`).setTitle('Redeem Key')
      .addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('key').setLabel('Tu key').setStyle(TextInputStyle.Short).setRequired(true)));
    return i.showModal(modal);
  }
  if (!s.enabled) return say(i, 'Script pausado.');
  if (!s.buyer_role_id) return say(i, 'El dueño del script todavía no configuró el rol de comprador.');
  if (!isBuyer(i.member, s)) return say(i, 'Necesitás el rol de comprador para usar esto.');
  if (blocked(s, i.user.id, i.member)) return say(i, 'Tu cuenta está bloqueada en este script.');
  const k = ownedKey(s.id, i.user.id);
  if (act === 'getscript') return k && !C.expired(k) ? say(i, '```lua\n' + C.loadstring(s.slug, BASE, k.k) + '\n```') : say(i, 'No tenés una key válida en este script. Usá Redeem Key.');
  if (!k) return say(i, 'No tenés una key canjeada en este script.');
  if (act === 'getrole') {
    try { await i.member.roles.add(s.buyer_role_id); } catch (e) { console.error('[role]', e.message); }
    return say(i, 'Rol entregado.');
  }
  if (act === 'resethwid') { const r = C.resetHwid(k, s); return say(i, r.error || 'HWID reiniciado.'); }
  if (act === 'stats') {
    const st = C.runStats(s.id);
    const exp = k.expires_at ? new Date(k.expires_at).toLocaleString('es-AR') : 'De por vida';
    const last = k.last ? new Date(k.last).toLocaleString('es-AR') : 'Nunca';
    return say(i, `**${s.slug}**\nVence: ${exp}\nHWID: ${k.hwid ? 'vinculado' : 'libre'}\nUsos: ${k.uses}\nÚltimo uso: ${last}\nEjecuciones — hoy: ${st.d1} · 7d: ${st.d7} · 30d: ${st.d30} · total: ${st.total}`);
  }
}

async function onModal(i) {
  const slug = i.customId.split('|')[2];
  const r = await redeemKey(i.member, i.user.id, i.fields.getTextInputValue('key'));
  return say(i, r.replace('**' + slug + '**', '**' + slug + '**'));
}

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });

client.once('ready', async () => {
  console.log('[bot] conectado como', client.user.tag);
  try {
    const body = defs.map((d) => d.toJSON());
    await client.application.commands.set(body);
  } catch (e) { console.error('[bot] comandos:', e.message); }
});
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
    if (i.isRepliable()) await say(i, 'Algo salió mal, probá de nuevo.').catch(() => {});
  }
});
client.on('messageCreate', async (msg) => {
  if (msg.author.bot || !msg.guild || !msg.content.toLowerCase().startsWith('.redeem ')) return;
  const member = msg.member || (await msg.guild.members.fetch(msg.author.id).catch(() => null));
  const r = await redeemKey(member, msg.author.id, msg.content.slice(8));
  msg.reply({ content: r, allowedMentions: { repliedUser: false } }).catch(() => {});
});

function start() {
  if (!TOKEN) return console.log('[bot] DISCORD_BOT_TOKEN no configurado');
  client.login(TOKEN).catch((e) => console.error('[bot] login:', e.message));
}
module.exports = { start };
