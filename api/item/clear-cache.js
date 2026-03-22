module.exports = async function handler(req, res) {
  global.pageCache = new Map();
  global.metadataCache = {};
  global.quickCache = {};
  return res.status(200).json({ success: true, message: 'Cache cleared' });
};