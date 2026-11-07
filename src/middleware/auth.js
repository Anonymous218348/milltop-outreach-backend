const jwt = require('jsonwebtoken');
const asyncHandler = require('../utils/asyncHandler');
const { HttpError } = require('../utils/httpError');
const db = require('../db');

const requireAuth = asyncHandler(async (req, _res, next) => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token) {
    throw new HttpError(401, 'Missing authorization token');
  }

  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET);
  } catch (_error) {
    throw new HttpError(401, 'Invalid or expired token');
  }

  const { rows } = await db.query('SELECT id, email, created_at, role, account_status, suspension_reason FROM users WHERE id = $1', [payload.sub]);
  if (!rows[0]) {
    throw new HttpError(401, 'User not found');
  }
  if (rows[0].account_status !== 'active') {
    throw new HttpError(403, 'This account is suspended.', {
      code: 'ACCOUNT_SUSPENDED',
      email: rows[0].email,
      reason: rows[0].suspension_reason || 'Your account was suspended after a review of activity that may have violated our policies.'
    });
  }

  req.user = rows[0];
  next();
});

module.exports = { requireAuth };
