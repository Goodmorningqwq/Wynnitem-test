# OpenClaw - Agent Guidelines

## Project Overview
Wynncraft item database browser with:
- **Frontend**: Vanilla JavaScript (ES modules) + HTML/TailwindCSS via CDN
- **Proxy**: Express.js server (CommonJS) handling API requests
- **API**: Queries Wynncraft's public API (api.wynncraft.com/v3)

## Commands

### Setup
```bash
cd proxy && npm install
```

### Running the Application
```bash
cd proxy && npm start
```
Server runs at http://localhost:3000. Refresh browser after code changes.

### Testing & Debugging
No formal test framework (Jest/Mocha) is configured. Testing is done manually:
```bash
cd proxy && node test-server.js   # Debug GET routes on port 3000
cd proxy && node test-post.js    # Test POST requests on port 3001
```

### Linting
No ESLint is configured. Ensure code follows the style guidelines below.

## Code Style

### General Rules
- 2-space indentation
- Single quotes for strings (`'string'`)
- No trailing commas
- No TypeScript - plain JavaScript only
- JSDoc comments for all exported functions
- No inline comments unless clarifying complex logic
- Use `const` by default, `let` only when reassignment is needed

### Naming Conventions
| Type | Convention | Example |
|------|------------|---------|
| Functions | camelCase | `fetchItems()` |
| Variables | camelCase | `currentPage` |
| Constants | UPPER_SNAKE | `ITEMS_PER_PAGE` |
| DOM Elements | camelCase + El | `itemsGridEl` |
| File Names | kebab-case | `api.js` |
| Classes | PascalCase | `AppState` |

### Imports/Modules
**Frontend (ES Modules):**
```javascript
import { cache, filterAndSortItems } from './api.js';
```
**Proxy Server (CommonJS):**
```javascript
const express = require('express');
const path = require('path');
module.exports = { app };
```

### Error Handling
```javascript
if (!response.ok) {
  throw new Error(`API Error: ${response.status}`);
}
if (e.message.includes('429') || e.message.includes('rate')) {
  rateLimitedUntil = Date.now() + 60000;
}
catch (e) {
  console.error('Proxy error:', e.message);
  return res.status(500).json({ error: e.message });
}
```

### Security
- Always escape HTML with `escapeHtml()` or `escapeAttr()`
- Never expose sensitive data in error messages
- Validate user inputs before processing
- Never log secrets, API keys, or credentials

## CSS/Tailwind
- Use TailwindCSS utility classes in HTML
- CSS custom properties for game theme in `:root`
- Prefer flexbox over floats

### Theme Colors
```css
:root {
  --game-bg: rgba(20, 8, 30, 0.9);
  --game-border: rgba(120, 68, 190, 0.7);
  --game-text: #e8e4ef;
  --game-positive: #58ff66;
  --game-negative: #ff5a68;
  --game-cyan: #2ce8ff;
}
```
```javascript
const TIER_COLORS = {
  common: '#FFFFFF', uncommon: '#22C55E', rare: '#3B82F6',
  epic: '#A855F7', legendary: '#F97316', fabled: '#EF4444', mythic: '#EC4899',
};
```

## Wynncraft API

### Endpoints
| Endpoint | TTL |
|----------|-----|
| `/api/item/database` | 24h |
| `/api/item/metadata` | 1h |
| `/api/item/quick` | 1m |

### Rate Limiting
- 1500ms between fetches
- 60s backoff on 429 errors
- 30s backoff after 3 consecutive errors

### Caching
- Server: Disk cache in `proxy/cache/` + in-memory Map
- Client: 1-hour TTL in `api.js` cache

## Project Structure
```
wynnitem/
├── index.html       # Main HTML
├── app.js           # Frontend (ES modules)
├── api.js           # API wrapper
├── PLAN.md          # Dev notes
└── proxy/
    ├── server.js    # Express server
    ├── test-server.js
    ├── test-post.js
    └── cache/
```

## Frontend Patterns

### API Wrapper
```javascript
export async function fetchItems(page = 1) {
  const url = buildUrl(DATABASE_ENDPOINT);
  url.searchParams.set('page', page.toString());
  const response = await fetch(url.toString());
  if (!response.ok) throw new Error(`API Error: ${response.status}`);
  return await response.json();
}
```

### HTML Templates
- Use template literals for multi-line HTML
- Always escape: `escapeHtml()` for text, `escapeAttr()` for attributes
- Use TailwindCSS classes

## Helper Functions
| Function | Purpose |
|----------|---------|
| `escapeHtml(value)` | Escape HTML special chars |
| `escapeAttr(value)` | Escape HTML attributes |
| `getTierStyle(tier)` | Get tier colors/glow |
| `getItemStats(item)` | Extract weapon/armor stats |
| `formatIdDisplayRange()` | Format ID ranges (10-20) |
| `formatIdName()` | camelCase to "Display Name" |