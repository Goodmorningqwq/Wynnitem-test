const express = require('express');
const path = require('path');
const app = express();
const PORT = 3000;

app.use((req, res, next) => {
  console.log('Middleware 1:', req.method, req.path);
  next();
});

app.use(express.json());

const WYNCRAFT_BASE = 'https://api.wynncraft.com/v3/item/database';

app.get('/proxy/v3/item/database', (req, res) => {
  console.log('Route matched!');
  res.json({ message: 'works' });
});

app.use((req, res, next) => {
  console.log('Middleware 2:', req.method, req.path);
  next();
});

const repoRoot = path.join(__dirname, '..');
console.log('Serving static from:', repoRoot);
app.use(express.static(repoRoot));

app.use((req, res) => {
  console.log('Final handler:', req.path);
});

app.listen(PORT, () => {
  console.log('Listening on', PORT);
});
