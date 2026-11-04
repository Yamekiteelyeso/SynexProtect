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
const sayE = (i, embeds) => (i.deferred || i.replied ? i.followUp({ embeds, ...ephemeral }) : i.reply({ embeds, ...ephemeral }));
const n = (x) => Number(x || 0).toLocaleString('en-US');
const denyEmbed = () => new EmbedBuilder().setColor(0xed4245).setTitle('¡NOT WHITELIST!')
  .setDescription('You need to be whitelisted to get this script.\nIf you have a script key, click on the Redeem button below to redeem it');
const statsEmbed = (s, st, k) => {
  const e = new EmbedBuilder().setColor(0x5865f2).setTitle(`📊 ${s.slug} · Stats`)
    .addFields({ name: 'Executions', value: `Today: **${n(st.d1)}**\n7 days: **${n(st.d7)}**\n30 days: **${n(st.d30)}**\nTotal: **${n(st.total)}**`, inline: true });
  if (k) e.addFields({ name: 'Your key', value: `Expires: ${k.expires_at ? new Date(k.expires_at).toLocaleString('en-US') : 'Lifetime'}\nHWID: ${k.hwid ? 'Linked' : 'Free'}\nUses: ${n(k.uses)}\nLast use: ${k.last ? new Date(k.last).toLocaleString('en-US') : 'Never'}`, inline: true });
  return e;
};

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
  if (!k) return 'Invalid key.';
  const s = db.prepare('select * from scripts where id=?').get(k.script_id);
  if (!s || !s.enabled) return "The script is paused or doesn't exist.";
  if (k.owner_discord_id && k.owner_discord_id !== uid) return 'That key was already redeemed by another account.';
  if (k.blacklisted || C.expired(k)) return 'Key expired or disabled.';
  if (blocked(s, uid, member)) return 'Your account is blocked on this script.';
  db.prepare('update lkeys set owner_discord_id=? where id=?').run(uid, k.id);
  if (s.buyer_role_id && member && member.roles && member.roles.add) {
    try { await member.roles.add(s.buyer_role_id); } catch (e) { console.error('[role]', e.message); }
  }
  return `Key redeemed on **${s.slug}**. You can now use the panel buttons.`;
}

const scriptOpt = (o) => o.setName('script').setDescription('Script slug').setRequired(true);
const defs = [
  new SlashCommandBuilder().setName('generatekey').setDescription('Generate keys for a script (admin)')
    .addStringOption(scriptOpt)
    .addIntegerOption((o) => o.setName('days').setDescription('Days valid (empty = lifetime)').setMinValue(1).setMaxValue(3650))
    .addIntegerOption((o) => o.setName('amount').setDescription('Amount, 1-50').setMinValue(1).setMaxValue(50)),
  new SlashCommandBuilder().setName('addtime').setDescription('Add days to a key (admin/manager)')
    .addStringOption((o) => o.setName('key').setDescription('Key').setRequired(true))
    .addIntegerOption((o) => o.setName('days').setDescription('Days to add').setRequired(true).setMinValue(1).setMaxValue(3650)),
  new SlashCommandBuilder().setName('deletekey').setDescription('Delete a key or all keys from a user (owner/manager)')
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
    .addStringOption((o) => o.setName('descripcion').setDescription('Panel description (optional)'))
    .addChannelOption((o) => o.setName('channel').setDescription('Channel to post in')),
  new SlashCommandBuilder().setName('delpanel').setDescription('Delete the panel of a script')
    .addStringOption((o) => o.setName('script').setDescription('Your script').setRequired(true).setAutocomplete(true)),
  new SlashCommandBuilder().setName('myscripts').setDescription('Show your scripts and their stats'),
  new SlashCommandBuilder().setName('stats').setDescription('Execution stats of a script (owner/admin)').addStringOption(scriptOpt),
  new SlashCommandBuilder().setName('redeem').setDescription('Redeem a key')
    .addStringOption((o) => o.setName('key').setDescription('Your key').setRequired(true)),
  new SlashCommandBuilder().setName('resterhwid').setDescription('Reset the HWID of a user on a script (owner/admin)')
    .addStringOption(scriptOpt)
    .addUserOption((o) => o.setName('user').setDescription('User').setRequired(true)),
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
    if (!rows.length) return say(i, "You don't have any scripts yet. Create them on the website.");
    const lines = rows.map((r) => { const st = C.runStats(r.id); return `• **${r.slug}** — ${r.enabled ? 'active' : 'paused'} · ${r.free ? 'free' : 'key required'} · today ${st.d1} · 7d ${st.d7} · 30d ${st.d30}`; });
    return say(i, `**Your scripts**\n${lines.join('\n')}`);
  }
  if (cmd === 'stats') return sayE(i, [statsEmbed(s, C.runStats(s.id), null)]);

  if (cmd === 'generatekey') {
    if (!isAdmin(i)) return say(i, 'Only a server administrator can generate keys.');
    const s = C.scriptBySlug(i.options.getString('script'));
    if (!s) return say(i, 'Script not found.');
    const keys = C.createKeys(s.id, { days: i.options.getInteger('days'), count: i.options.getInteger('amount') || 1 });
    return say(i, `Keys for **${s.slug}**:\n${keys.map((k) => '`' + k + '`').join('\n')}`);
  }

  if (cmd === 'addtime') {
    if (!isManager(i)) return say(i, 'Only a server administrator or manager can use this.');
    const k = db.prepare('select * from lkeys where k=?').get(i.options.getString('key').trim());
    if (!k) return say(i, 'Key not found.');
    const base = Math.max(Date.now(), k.expires_at || 0);
    db.prepare('update lkeys set expires_at=? where id=?').run(base + i.options.getInteger('days') * C.DAY, k.id);
    return say(i, 'Time added.');
  }

  const s = ownScript(i, i.options.getString('script'));
  if (!s) return say(i, "I couldn't find that script in your account.");

  if (cmd === 'deletekey') {
    const key = i.options.getString('key'), user = i.options.getUser('user');
    let r = { changes: 0 };
    if (key) r = db.prepare('delete from lkeys where script_id=? and k=?').run(s.id, key.trim());
    else if (user) r = db.prepare('delete from lkeys where script_id=? and owner_discord_id=?').run(s.id, user.id);
    else return say(i, 'Provide a key or a user.');
    return say(i, r.changes ? `Deleted: ${r.changes}` : 'Nothing found to delete.');
  }
  if (cmd === 'blacklist') {
    const u = i.options.getUser('user'), r = i.options.getRole('role');
    if (!u && !r) return say(i, 'Provide a user or a role.');
    if (u) db.prepare('insert or ignore into blacklist(script_id,target) values(?,?)').run(s.id, u.id);
    if (r) db.prepare('insert or ignore into blacklist(script_id,target) values(?,?)').run(s.id, r.id);
    return say(i, 'Blocked in ' + s.slug + '.');
  }
  if (cmd === 'getrole') {
    db.prepare('update scripts set buyer_role_id=? where id=?').run(i.options.getRole('role').id, s.id);
    return say(i, 'Buyer role set.');
  }
  if (cmd === 'resterhwid') {
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
      if (alive) return say(i, `A panel for **${s.slug}** already exists in <#${existing.channel_id}>. Use /delpanel to delete it first.`);
      db.prepare('delete from panels where script_id=?').run(s.id);
    }
    const channel = i.options.getChannel('channel') || i.channel;
    if (!channel || !channel.isTextBased || !channel.isTextBased()) return say(i, 'Pick a text channel.');
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
    return say(i, `Panel for **${s.slug}** posted in <#${channel.id}>.`);
  }
  if (cmd === 'delpanel') {
    const p = db.prepare('select * from panels where script_id=?').get(s.id);
    if (!p) return say(i, 'That script has no panel posted.');
    await deletePanel(p);
    return say(i, 'Panel deleted.');
  }
}

async function onButton(i) {
  const [, act, slug] = i.customId.split('|');
  const s = C.scriptBySlug(slug);
  if (!s) return say(i, 'Script not found.');
  if (act === 'redeem') {
    const modal = new ModalBuilder().setCustomId(`sx|modal|${slug}`).setTitle('Redeem Key')
      .addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('key').setLabel('Your key').setStyle(TextInputStyle.Short).setRequired(true)));
    return i.showModal(modal);
  }
  if (!s.enabled) return say(i, 'Script paused.');
  if (!s.buyer_role_id || !isBuyer(i.member, s)) return sayE(i, [denyEmbed()]);
  if (blocked(s, i.user.id, i.member)) return say(i, 'Your account is blocked on this script.');
  const k = ownedKey(s.id, i.user.id);
  if (act === 'getscript') return k && !C.expired(k) ? say(i, '```lua\n' + C.loadstring(s.slug, BASE, k.k) + '\n```') : say(i, "You don't have a valid key on this script. Use Redeem Key.");
  if (!k) return say(i, "You don't have a redeemed key on this script.");
  if (act === 'getrole') {
    try { await i.member.roles.add(s.buyer_role_id); } catch (e) { console.error('[role]', e.message); }
    return say(i, 'Role granted.');
  }
  if (act === 'resethwid') { const r = C.resetHwid(k, s); return say(i, r.error || 'HWID reset.'); }
  if (act === 'stats') return sayE(i, [statsEmbed(s, C.runStats(s.id), k)]);
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
    if (i.isRepliable()) await say(i, 'Something went wrong, please try again.').catch(() => {});
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
