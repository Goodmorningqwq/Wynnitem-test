/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './*.html',
    './app.js',
    './api.js',
    './guilds.js',
    './guilds-v2.js',
    './guild-leaderboard.js',
    './guild-event-history.js'
  ],
  theme: {
    extend: {
      colors: {
        common: '#FFFFFF',
        uncommon: '#22C55E',
        rare: '#3B82F6',
        epic: '#A855F7',
        legendary: '#F97316',
        fabled: '#EF4444',
        mythic: '#EC4899',
        gray: {
          750: '#374151'
        }
      }
    }
  },
  plugins: []
};
