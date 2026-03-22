# Wynncraft Item Database Website - Project Plan

## 📋 Overview

A web application that connects to the Wynncraft API v3 to browse, search, and explore game items.

**API Base:** `https://api.wynncraft.com/v3/item`

---

## 🎯 Core Features

### 1. **Item Browser**
- Paginated item list (default API returns paginated results)
- Option to load full database (`?fullResult` flag)
- Item cards showing: name, type, tier, level, icon
- Click to view full item details

### 2. **Item Search**
- POST endpoint with filters:
  - Query (name search)
  - Type (weapons, armour, accessories, tools, etc.)
  - Tier (common, rare, legendary, etc.)
  - Level range
  - Attack speed (for weapons)
  - Professions
  - Identifications (stats like spellDamage, fireDamage, etc.)
  - Major IDs (special effects)

### 3. **Item Detail View**
- Full item information:
  - Icon & internal name
  - Type & subtype
  - Requirements (level, strength, dexterity, intelligence, defence, agility, class, quest)
  - Identifications (min/max/raw values)
  - Major IDs with descriptions
  - Powder slots
  - Lore text
  - Drop metadata (coordinates, mob type, location name)
  - Base stats (damage, attack speed, DPS)
  - Craftable materials (if applicable)

### 4. **Filter Metadata Explorer**
- GET `/v3/item` metadata endpoint
- Shows all available:
  - Identification types
  - Major ID names
  - Item types & subtypes
  - Tier options
  - Level ranges

---

## 🏗️ Technical Architecture

### Frontend Stack

**HTML + Tailwind CSS + Vanilla JS**
- `index.html` - Main page with Tailwind classes
- Tailwind via CDN (development) or CLI build (production)
- `app.js` - API calls & DOM manipulation
- No framework build step, clean utility-first CSS

**Why Tailwind:**
- Rapid UI development
- Consistent design system
- Responsive utilities built-in
- Easy to customize colors (perfect for item tier colors)
- Large community & documentation

### Backend (Optional)

**Client-Side Only:**
- Direct fetch calls to Wynncraft API
- Pros: Simple, no server needed
- Cons: CORS issues, rate limits hit browser

**With Proxy Server:**
- Node.js/Express or Python/Flask
- Pros: Cache responses, handle rate limits, avoid CORS
- Cons: More complex, requires hosting

**Recommendation:** Start **client-side only**, add proxy if needed.

---

## 📁 Project Structure

```
openclaw/
├── index.html          # Main page with Tailwind classes
├── app.js              # Main application logic
├── api.js              # API wrapper functions
├── tailwind.config.js  # Tailwind config (for build step)
├── input.css           # Tailwind directives (@tailwind base/components/utilities)
├── output.css          # Built Tailwind CSS (production)
├── components/         # UI components (if modular)
│   ├── itemCard.js
│   ├── searchForm.js
│   └── itemModal.js
├── utils/              # Helper functions
│   ├── cache.js        # Response caching
│   └── formatter.js    # Data formatting
└── assets/             # Images, icons
    └── wynncraft-logo.png
```

### Tailwind Setup Options

**Development (CDN - Quick Start):**
```html
<script src="https://cdn.tailwindcss.com"></script>
<script>
  tailwind.config = {
    theme: {
      extend: {
        colors: {
          'common': '#FFFFFF',
          'uncommon': '#22C55E',
          'rare': '#3B82F6',
          'epic': '#A855F7',
          'legendary': '#F97316',
          'fabled': '#EF4444',
          'mythic': '#EC4899'
        }
      }
    }
  }
</script>
```

**Production (CLI Build - Recommended):**
```bash
npm install -D tailwindcss
npx tailwindcss init
# Configure tailwind.config.js
npx tailwindcss -i ./input.css -o ./output.css --watch
```

---

## 🔌 API Integration

### Key Endpoints

| Endpoint | Method | TTL | Purpose |
|----------|--------|-----|---------|
| `/v3/item` | GET | 1 hour | Item database (paginated) |
| `/v3/item?fullResult` | GET | 1 hour | Full item database |
| `/v3/item` | POST | - | Filtered item search |
| `/v3/item` (quick) | GET | 1 min | Quick search |
| `/v3/item` (metadata) | GET | 1 hour | Filter metadata |

### Rate Limit Notes
- Most endpoints: **1 hour TTL** (cached by API)
- Quick search: **1 minute TTL**
- Plan: Implement client-side caching to respect TTLs

### Sample API Call

```javascript
// Get item database
const response = await fetch('https://api.wynncraft.com/v3/item');
const data = await response.json();

// Access items
const items = data.results; // Object with item names as keys
const pagination = data.controller; // Pagination info
```

---

## 🎨 UI/UX Design

### Pages

1. **Home/Browser** - Item grid with pagination
2. **Search** - Advanced filter form
3. **Item Detail** - Modal or dedicated page
4. **Metadata** - Reference for all filter options

### Components

- **Search Bar** - Quick name search
- **Filter Panel** - Collapsible advanced filters
- **Item Card** - Icon, name, tier color, level
- **Item Modal** - Full details on click
- **Pagination Controls** - Page navigation
- **Loading States** - Skeletons or spinners
- **Error Handling** - Graceful API failure messages

### Color Coding (by tier) - Tailwind Custom Colors
- Common: `text-common` / `border-common` (#FFFFFF)
- Uncommon: `text-uncommon` / `border-uncommon` (#22C55E)
- Rare: `text-rare` / `border-rare` (#3B82F6)
- Epic: `text-epic` / `border-epic` (#A855F7)
- Legendary: `text-legendary` / `border-legendary` (#F97316)
- Fabled: `text-fabled` / `border-fabled` (#EF4444)
- Mythic: `text-mythic` / `border-mythic` (#EC4899)

**Example:**
```html
<div class="border-2 border-legendary bg-gray-800 p-4 rounded-lg">
  <span class="text-legendary font-bold">Legendary Item</span>
</div>
```

---

## 🚀 Development Phases

### Phase 1: MVP
- [ ] Basic HTML structure
- [ ] Fetch item database (paginated)
- [ ] Display items in grid
- [ ] Click to view item details (modal)
- [ ] Basic search by name

### Phase 2: Search & Filters
- [ ] Advanced search form
- [ ] Type/tier/level filters
- [ ] Identification filters
- [ ] Major ID filters
- [ ] POST search endpoint integration

### Phase 3: Polish
- [ ] Caching layer (respect API TTLs)
- [ ] Responsive design (mobile-friendly)
- [ ] Loading states & error handling
- [ ] Pagination improvements
- [ ] Item comparison feature

### Phase 4: Advanced
- [ ] User preferences (saved filters)
- [ ] Export item data (JSON/CSV)
- [ ] Price tracking (if API supports)
- [ ] Build crafting calculator
- [ ] Drop location map integration

---

## ⚠️ Technical Considerations

### CORS
- Wynncraft API may have CORS restrictions
- Solution: Use JSONP, proxy server, or check if CORS is enabled

### Caching Strategy
- Respect API TTLs (1 hour for most endpoints)
- Use `localStorage` or `sessionStorage` for client cache
- Cache key: endpoint + parameters + timestamp

### Performance
- Item database is large - paginate results
- Lazy load item details (fetch on click)
- Debounce search inputs
- Virtual scrolling for large lists

### Error Handling
- API downtime
- Rate limit exceeded (429)
- Network failures
- Invalid filter combinations

---

## 📝 Next Steps

1. **Choose stack** (vanilla vs framework)
2. **Set up project structure**
3. **Build Phase 1 MVP**
4. **Test with real API**
5. **Iterate based on feedback**

---

## 🔗 References

- **API Docs:** https://docs.wynncraft.com/docs/modules/item.html
- **Main Docs:** https://docs.wynncraft.com/
- **Discord:** https://discord.gg/nUFD9xX
- **Item Guide:** https://wynncraft.fandom.com/wiki/Items

---

*Ready to start building? Let me know which phase to tackle first!*
