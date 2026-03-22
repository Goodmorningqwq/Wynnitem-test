# OpenClaw - Agent Guidelines

## Project Overview

OpenClaw is a Wynncraft item database browser with:
- **Frontend**: Vanilla JavaScript (ES modules) + HTML/TailwindCSS via CDN
- **Proxy**: Express.js server (CommonJS) handling API requests
- **API**: Queries Wynncraft's public API (api.wynncraft.com/v3)

## Commands

### Running the Application
```bash
cd proxy && npm install
cd proxy && npm start
```
Server runs at http://localhost:3000. Refresh browser after code changes.

### Testing
No formal test suite. Manual testing via browser at http://localhost:3000.
- `proxy/test-server.js` - Alternative test server for debugging routes
- `proxy/test-post.js` - Test server for POST request debugging (port 3001)

### Linting/Type Checking
No linting or type checking configured. Follow the code style guidelines below.

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
// Use .js extension in imports
import { cache, filterAndSortItems } from './api.js';
```

**Proxy Server (CommonJS):**
```javascript
// Use require() without extensions
const express = require('express');
const path = require('path');
module.exports = { app };
```

### Error Handling
```javascript
// API errors
if (!response.ok) {
  throw new Error(`API Error: ${response.status}`);
}

// Rate limiting
if (e.message.includes('429') || e.message.includes('rate')) {
  rateLimitedUntil = Date.now() + 60000;
}

// Server errors
catch (e) {
  console.error('Proxy error:', e.message);
  return res.status(500).json({ error: e.message });
}
```

### Security
- Always escape HTML when rendering user data with `escapeHtml()` or `escapeAttr()`
- Never expose sensitive data in error messages
- Validate user inputs before processing

## CSS/Tailwind

- Use TailwindCSS utility classes in HTML
- CSS custom properties for game theme colors in `:root`
- Prefer flexbox over floats

### Theme System (CSS Variables)
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

### Tier Colors
```javascript
const TIER_COLORS = {
  common: '#FFFFFF', uncommon: '#22C55E', rare: '#3B82F6',
  epic: '#A855F7', legendary: '#F97316', fabled: '#EF4444', mythic: '#EC4899',
};
```

## Wynncraft API Integration

### Endpoints
| Endpoint | Purpose | Cache TTL |
|----------|---------|-----------|
| `/api/item/database` | Paginated item list (276 pages) | 24h |
| `/api/item/metadata` | Available filters/identifications | 1h |
| `/api/item/quick` | Quick search by name | 1m |

### Rate Limiting
- Min 1500ms between fetches
- 60-second backoff on 429 errors
- 30-second backoff after 3 consecutive errors

### Caching Strategy
- Server-side: Disk cache in `proxy/cache/` + in-memory Map
- Client-side: 1-hour TTL in `api.js` cache object

## Project Structure
```
wynnitem/
├── index.html       # Main HTML page with embedded styles
├── app.js           # Frontend application logic (ES modules)
├── api.js           # API wrapper functions (ES modules)
├── PLAN.md          # Development notes
└── proxy/
    ├── server.js     # Express proxy server (CommonJS)
    ├── package.json  # "type": "commonjs"
    └── cache/        # Server-side response cache
```

## Frontend Patterns

### API Wrapper (api.js)
```javascript
export async function fetchItems(page = 1) {
  const url = buildUrl(DATABASE_ENDPOINT);
  url.searchParams.set('page', page.toString());
  const response = await fetch(url.toString());
  if (!response.ok) {
    throw new Error(`API Error: ${response.status}`);
  }
  return await response.json();
}
```

### HTML Templates in JS
- Use template literals (backticks) for multi-line HTML strings
- Always escape user data: `escapeHtml()` for text, `escapeAttr()` for attributes
- TailwindCSS classes for styling

## Helper Functions
| Function | Purpose |
|----------|---------|
| `escapeHtml(value)` | Escape HTML special characters |
| `escapeAttr(value)` | Escape HTML attributes |
| `getTierStyle(tier)` | Get text/border colors and glow RGB for tier |
| `getItemStats(item)` | Extract weapon/armor stats |
| `formatIdDisplayRange()` | Format ID values (e.g., "10-20") |
| `formatIdName()` | Convert camelCase to "Display Name" |

## API Response Types

### Database Page Response
```javascript
{
  controller: { count, pages, next, prev },
  results: { "ItemName": { type, rarity, requirements, ... }, ... }
}
```

### Item Data Structure
```javascript
{
  name: string,
  type: "weapon" | "armour" | "accessory",
  rarity: string,
  requirements: { level, strength, ... },
  base: { baseDamage, baseHealth, ... },
  attackSpeed: string,
  powderSlots: 0-3,
  identifications: { rawStrength, ... },
  majorIds: { "ID Name": "Description", ... }
}
```
