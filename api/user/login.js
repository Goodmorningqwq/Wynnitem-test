const { Redis } = require('@upstash/redis');

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL_GUILD,
  token: process.env.UPSTASH_REDIS_REST_TOKEN_GUILD,
});

function simpleHash(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return hash.toString(16);
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }

  try {
    const usersKey = 'users';
    const userDataStr = await redis.hget(usersKey, username);

    if (!userDataStr) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    const userData = typeof userDataStr === 'string' ? JSON.parse(userDataStr) : userDataStr;
    const passwordHash = simpleHash(password);

    if (userData.passwordHash !== passwordHash) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    return res.json({ success: true, username: username });
  } catch (e) {
    console.error('Login error:', e);
    return res.status(500).json({ error: e.message });
  }
};
