/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./index.html', './territories-map.js', './script.js'],
  theme: {
    extend: {
      colors: {
        common: '#FFFFFF',
        uncommon: '#22C55E',
        rare: '#3B82F6',
        epic: '#A855F7',
        legendary: '#F97316',
        fabled: '#EF4444',
        mythic: '#EC4899'
      }
    }
  },
  plugins: []
};
