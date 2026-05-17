# OpenClaw - Agent Guidelines

## Architecture

- **Production**: Vercel serverless functions in `api/` directory (no local server)
- **Local debug**: Express server at `proxy/server.js` (port 3000)
- **Frontend**: Vanilla JS ES modules + TailwindCSS via CDN

## Entry Points

- Frontend pages: `index.html`, `item.html`, `guild.html`, `guild-leaderboard.html`, `player-stats.html`
- Vercel APIs: `api/item/*.js`, `api/guild/*.js`, `api/user/*.js`
- Local proxy: `proxy/server.js`

## Commands

```bash
# Local development (optional - Vercel is primary)
cd proxy && npm install && npm start

# Build CSS
npm run build    # tailwindcss -i ./input.css -o ./output.css --minify
```

## Environment Variables

Required for Vercel deployment:
- `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` (item cache)
- `UPSTASH_REDIS_REST_URL_GUILD` + `UPSTASH_REDIS_REST_TOKEN_GUILD` (user/guild data)
- `DISCORD_NOTIFY_SECRET` (optional, for webhook notifications)

## Code Style

- 2-space indentation, single quotes, no trailing commas
- `const` by default, `let` for reassignment
- Frontend: ES modules (`import`), Backend: CommonJS (`require`)
- Escape HTML: `escapeHtml()` for text, `escapeAttr()` for attributes
- No TypeScript - plain JavaScript only

## Caching

- Item cache: 12-hour TTL in Redis, self-healing on cache miss
- `api/item/database` endpoint has 3 fallback strategies (full cache → page rebuild → upstream bootstrap)