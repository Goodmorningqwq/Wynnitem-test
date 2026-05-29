# OpenClaw - Agent Guidelines

## Architecture

- **Production**: Vercel serverless functions in `api/` (no local server needed)
- **Local debug**: Express proxy at `proxy/server.js` (port 3000, file-based cache)
- **Separate site**: `territory-map-site/` has its own `vercel.json`, `package.json`, and Tailwind build
- **Frontend**: Vanilla JS ES modules + TailwindCSS CDN
- **Two Redis databases** (Upstash): item cache vs guild/user data (separate env var pairs)

## Entry Points

- **HTML pages**: `index.html`, `item.html`, `guild.html`, `guild-dashboard.html`, `guild-leaderboard.html`, `guild-event-history.html`, `player-stats.html`, `login.html`
- **Frontend JS**: `app.js` (main), `api.js` (API wrapper), `guilds.js`, `guilds-v2.js`, `guild-leaderboard.js`, `guild-event-history.js`, `player-stats.js`
- **Vercel APIs**: `api/item/` (database, metadata, quick, prewarm, refresh, clear-cache), `api/guild/` (index, events), `api/user/` (auth, data), `api/profile.js`, `api/territories.js`

## Commands

```bash
# Build CSS (root)
npm run build

# Build CSS (territory-map-site, from repo root)
cd territory-map-site && npm run build

# Local dev proxy (optional — Vercel is primary)
cd proxy && npm install && npm start
```

No test framework. Playwright is in devDependencies but no test scripts exist.

## Vercel Routes & Crons

- **URL rewrites** (vercel.json): `/` → `index.html`, `/item` → `item.html`, `/guild/leaderboard` → `guild-leaderboard.html`, `/guild/event_history` → `guild-event-history.html`, `/guild/search` → `guild.html`, `/guild/dashboard` → `guild-dashboard.html`, `/guild` → `guild.html`, `/player-stats` → `player-stats.html`, `/login` → `login.html`
- **API rewrites**: `/api/user/login` → `auth?action=login`, `/api/user/register` → `auth?action=register`, `/api/discord/webhook-link` → `events?discordAction=webhook-link`, `/api/discord/notify` → `events?discordAction=notify`
- **Crons**: `0 0 * * *` → `/api/item/refresh`, `55 23 * * 0` → `/api/guild/weekly-reset`

## Environment Variables

| Variable | Purpose |
|---|---|
| `UPSTASH_REDIS_REST_URL` + `_TOKEN` | Item cache DB |
| `UPSTASH_REDIS_REST_URL_GUILD` + `_TOKEN_GUILD` | Guild/user data DB |
| `CACHE_ADMIN_TOKEN` | Required for manual `/api/item/refresh` (cron uses `x-vercel-cron` header) |
| `DISCORD_NOTIFY_SECRET` | Optional, webhook notifications |

## Caching

- **Item DB**: 12h TTL on `wynn_full_db`, 30-day TTL on `wynn_full_db_last_good` and `wynn_discovered_pages`
- **`/api/item/database` 4-layer fallback**: full cache → last-good cache → page-rebuild from cached pages → upstream bootstrap (8.5s budget, max 40 pages)
- **`/api/item/refresh`**: uses Redis NX lock (`wynn_refresh_lock`, 15-min TTL) to prevent concurrent runs
- **Page keys**: `wynn_page_{n}` with 12h TTL
- **`/api/item/prewarm`**: caches all ~276 pages, takes ~7-8 minutes

## Code Style

- 2-space indentation, single quotes, no trailing commas
- `const` by default, `let` for reassignment
- Frontend: ES modules (`import`), Backend: CommonJS (`require`)
- Escape HTML: `escapeHtml()` for text, `escapeAttr()` for attributes
- No TypeScript — plain JavaScript only

## Key Patterns

- Redis clients instantiated per-file at module scope (not shared)
- **`safeParse()`** (item APIs) and **`parseJsonSafe(value, fallback)`** (guild/user APIs) handle Redis values that may already be objects
- **Auth**: pbkdf2 with random salt; legacy simple-hash users auto-upgraded on login
- `.gitignore` excludes `*.json` except `package.json` — lockfiles are not tracked
