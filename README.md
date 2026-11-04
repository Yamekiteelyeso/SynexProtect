# Synex Protect

Web + bot de Discord para proteger y vender scripts Lua (estilo Luarmor / Lexy Protect).

## Instalar
1. `npm install`
2. Copiá `.env.example` a `.env` y completá los valores.
3. Discord Developer Portal: en tu app, OAuth2 > Redirects agregá `BASE_URL/auth/discord/callback`. En Bot, activá **Message Content Intent** (para `.redeem`).
4. `npm start`

## Plan
- Gratis: hasta 4 scripts. Pro y admin: ilimitados. Admin: scripts de 100 MB (usuarios: 1 MB).
- `OWNER_ID` = tu ID de Discord (cuenta admin automática).

## Loader
```
script_key="XXXX";
loadstring(game:HttpGet("https://TU-DOMINIO/files/v1/loaders/mi-script.lua"))()
```
El código viaja cifrado en un flujo que depende de la key y de un nonce por ejecución, y el servidor valida key, HWID, vencimiento y blacklist antes de entregarlo.

## Comandos del bot
/generatekey, /addtime, /deletekey, /blacklist, /getrole, /panel, /redeem (o `.redeem KEY`), /resterhwid (nombre tal cual lo pediste; se puede renombrar en bot.js).

## Railway (paso a paso)
1. Creá el proyecto desde el repo (o `railway up`). Railway usa `railway.json`: `npm start` y health check en `/health`.
2. En **Variables** cargá: `DISCORD_BOT_TOKEN`, `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `OWNER_ID`, `SESSION_SECRET` (algo largo), `DISCORD_GUILD_ID` (opcional, comandos instantáneos en tu servidor).
3. En **Volumes** creá uno montado en `/data`. La base se guarda en `/data/synex.db` automáticamente.
4. Generá el dominio público en **Settings > Networking**. La URL se toma sola de `RAILWAY_PUBLIC_DOMAIN`.
5. En el Developer Portal: Redirect `https://TU-DOMINIO/auth/discord/callback` y Message Content Intent activado.
- Variables: `DISCORD_BOT_TOKEN`, `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `OWNER_ID`, `SESSION_SECRET`, `DB_PATH=/data/synex.db` (con un Volume montado en `/data`).
- El dominio se toma de `RAILWAY_PUBLIC_DOMAIN` si no ponés `BASE_URL`.
- Nunca subas el token al repo.
