# Wynnitem-test

Wynncraft Item Database Browser

## Features
- Browse weapons, armor, accessories, and misc items
- Search and filter by tier, level, and type
- Detailed item stats and lore
- Powered by Wynncraft API with Redis caching (Upstash)

## Cache Management

### Pre-warm Cache
To cache all 276 pages for instant browsing, visit this endpoint once:
```
https://wynnitem-test.vercel.app/api/item/prewarm
```
Warning: This takes ~7-8 minutes to complete.

### Cache Status
- All pages return `X-Cache: HIT` when served from Redis
- Pages are cached for 12 hours

## Development

### Local Setup
```bash
cd proxy && npm install && npm start
```

### Vercel Deployment
Environment variables required:
- `UPSTASH_REDIS_REST_URL`
- `UPSTASH_REDIS_REST_TOKEN`
