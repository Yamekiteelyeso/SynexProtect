const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');
let file = process.env.DB_PATH || '';
// En Railway con Volume en /data, siempre usamos /data (una ruta relativa se borra en cada deploy).
if (!file || (!path.isAbsolute(file) && fs.existsSync('/data'))) file = fs.existsSync('/data') ? '/data/synex.db' : path.join(__dirname, 'data', 'synex.db');
console.log('[db] usando', file, fs.existsSync('/data') ? '(Volume detectado)' : '(sin /data: los datos pueden perderse en cada deploy)');
fs.mkdirSync(path.dirname(file), { recursive: true });
const db = new DatabaseSync(file);
db.exec('PRAGMA journal_mode = WAL;');
const USERS = `create table users(id integer primary key, discord_id text unique, username text not null, email text unique, pass text, plan text default 'free', admin integer default 0, created integer)`;
const ucols = db.prepare('pragma table_info(users)').all();
if (ucols.length && !ucols.some((c) => c.name === 'email')) {
  db.exec(`alter table users rename to users_old; ${USERS}; insert into users(id,discord_id,username,plan,admin,created) select id,discord_id,username,plan,admin,created from users_old; drop table users_old;`);
}
db.exec(`
create table if not exists users(id integer primary key, discord_id text unique, username text not null, email text unique, pass text, plan text default 'free', admin integer default 0, created integer);
create table if not exists scripts(
  id integer primary key, user_id integer not null, slug text unique not null, name text,
  content text not null, enabled integer default 1, free integer default 0,
  buyer_role_id text, hwid_days integer default 7, runs integer default 0, created integer);
create table if not exists lkeys(
  id integer primary key, script_id integer not null, k text unique not null,
  owner_discord_id text, expires_at integer, hwid text, hwid_reset_at integer,
  blacklisted integer default 0, uses integer default 0, last integer, created integer);
create table if not exists blacklist(script_id integer not null, target text not null, primary key(script_id, target));
create table if not exists panels(script_id integer primary key, channel_id text not null, message_id text not null unique, created integer);
create table if not exists execs(id integer primary key, script_id integer not null, ts integer not null);
create index if not exists ix_lk on lkeys(script_id);
create index if not exists ix_ex on execs(script_id, ts);
`);
db.prepare('delete from execs where ts < ?').run(Date.now() - 90 * 864e5);
db.DB_FILE = file;
module.exports = db;
