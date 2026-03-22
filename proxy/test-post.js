const express = require('express');
const path = require('path');
const app = express();
app.use(express.json());

app.all('/api/test', (req, res) => {
  console.log('Method:', req.method);
  res.json({ method: req.method });
});

app.use((req, res, next) => {
  if (req.method === 'GET' && (req.path.endsWith('.html') || req.path.endsWith('.js') || req.path === '/')) {
    return express.static(path.join(__dirname, '..'))(req, res, next);
  }
  next();
});

app.listen(3001, () => console.log('Test server on 3001'));
