const db = require('../db');

const getSettings = async (userId) => {
  const { rows } = await db.query('SELECT * FROM user_settings WHERE user_id = $1', [userId]);
  return rows[0] || null;
};

const normalizeGmailAccounts = (accounts) => (Array.isArray(accounts) ? accounts : []).map((account) => {
  if (typeof account !== 'string') return account || {};
  try { return JSON.parse(account); } catch { return { email: account, pass: '' }; }
});

const getApiKey = async (userId, field, envName) => {
  const settings = await getSettings(userId);
  return (settings && settings[field]) || process.env[envName] || '';
};

const getGmailAccounts = async (userId) => {
  const settings = await getSettings(userId);
  return normalizeGmailAccounts(settings?.gmail_accounts);
};

module.exports = { getSettings, getApiKey, getGmailAccounts, normalizeGmailAccounts };
