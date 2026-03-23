const { Redis } = require('@upstash/redis');
const crypto = require('crypto');

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL_GUILD,
  token: process.env.UPSTASH_REDIS_REST_TOKEN_GUILD,
});

function hashPassword(password, salt) {
  return crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha256').toString('hex');
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }

  if (username.length < 3 || username.length > 20) {
    return res.status(400).json({ error: 'Username must be 3-20 characters' });
  }

  if (password.length < 4) {
    return res.status(400).json({ error: 'Password must be at least 4 characters' });
  }

  try {
    const usersKey = 'users';
    const existingUser = await redis.hget(usersKey, username);

    if (existingUser) {
      return res.status(409).json({ error: 'Username already exists' });
    }

    const passwordSalt = crypto.randomBytes(16).toString('hex');
    const userData = {
      username: username,
      passwordSalt: passwordSalt,
      passwordHash: hashPassword(password, passwordSalt),
      createdAt: Date.now()
    };

    await redis.hset(usersKey, { [username]: JSON.stringify(userData) });

    return res.json({ success: true, username: username });
  } catch (e) {
    console.error('Register error:', e);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
