const { Redis } = require('@upstash/redis');
const crypto = require('crypto');

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

function hashPassword(password, salt) {
  return crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha256').toString('hex');
}

function safeEqual(a, b) {
  const aBuf = Buffer.from(a, 'hex');
  const bBuf = Buffer.from(b, 'hex');
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
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
    let validPassword = false;

    if (userData.passwordSalt && userData.passwordHash) {
      const passwordHash = hashPassword(password, userData.passwordSalt);
      validPassword = safeEqual(userData.passwordHash, passwordHash);
    } else if (userData.passwordHash) {
      // Backward compatibility for existing users; upgraded after successful login.
      validPassword = userData.passwordHash === simpleHash(password);
      if (validPassword) {
        const passwordSalt = crypto.randomBytes(16).toString('hex');
        userData.passwordSalt = passwordSalt;
        userData.passwordHash = hashPassword(password, passwordSalt);
        await redis.hset(usersKey, { [username]: JSON.stringify(userData) });
      }
    }

    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    return res.json({ success: true, username: username });
  } catch (e) {
    console.error('Login error:', e);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
