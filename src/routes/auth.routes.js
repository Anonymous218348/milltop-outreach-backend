const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const { body } = require('express-validator');
const db = require('../db');
const asyncHandler = require('../utils/asyncHandler');
const { validate } = require('../utils/validation');
const { HttpError } = require('../utils/httpError');

const router = express.Router();
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 15,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many authentication attempts. Please try again later.' }
});

const tokenFor = (user) => jwt.sign(
  { sub: user.id, email: user.email },
  process.env.JWT_SECRET,
  { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
);

router.post('/register', authLimiter,
  body('email').isEmail().normalizeEmail(),
  body('password').isLength({ min: 8 }),
  validate,
  asyncHandler(async (req, res) => {
    const { email, password } = req.body;
    const countryCode = process.env.TRUST_CLOUDFLARE_IP_COUNTRY === 'true'
      ? String(req.get('cf-ipcountry') || '').toUpperCase().match(/^[A-Z]{2}$/)?.[0] || null
      : null;
    if (countryCode) {
      const { rows: rules } = await db.query('SELECT reason FROM admin_country_rules WHERE country_code=$1 AND blocked=TRUE', [countryCode]);
      if (rules[0]) {
        await db.query(`INSERT INTO user_access_events(email,event_type,ip_address,country_code,success,detail)
          VALUES($1,'signup_blocked',$2,$3,FALSE,$4)`, [email, req.ip || null, countryCode, rules[0].reason || 'Country restricted']);
        throw new HttpError(403, 'Signups are not available from your location.');
      }
    }
    const hashed = await bcrypt.hash(password, 12);
    try {
      const { rows } = await db.query(
        `INSERT INTO users (email, password, signup_ip, signup_country)
         VALUES ($1, $2, $3, $4) RETURNING id, email, created_at, role, account_status`,
        [email, hashed, req.ip || null, countryCode]
      );
      await db.query(
        `INSERT INTO user_access_events (user_id, email, event_type, ip_address, country_code, success)
         VALUES ($1, $2, 'signup', $3, $4, TRUE)`,
        [rows[0].id, email, req.ip || null, countryCode]
      );
      res.status(201).json({ user: rows[0], token: tokenFor(rows[0]) });
    } catch (error) {
      if (error.code === '23505') throw new HttpError(409, 'Email is already registered');
      throw error;
    }
  })
);

router.post('/login', authLimiter,
  body('email').isEmail().normalizeEmail(),
  body('password').notEmpty(),
  validate,
  asyncHandler(async (req, res) => {
    const { email, password } = req.body;
    const countryCode = process.env.TRUST_CLOUDFLARE_IP_COUNTRY === 'true'
      ? String(req.get('cf-ipcountry') || '').toUpperCase().match(/^[A-Z]{2}$/)?.[0] || null
      : null;
    const { rows } = await db.query('SELECT id, email, password, created_at, role, account_status FROM users WHERE email = $1', [email]);
    const user = rows[0];
    if (!user || !(await bcrypt.compare(password, user.password))) {
      await db.query(
        `INSERT INTO user_access_events (email, event_type, ip_address, success)
         VALUES ($1, 'login', $2, FALSE)`,
        [email, req.ip || null]
      );
      throw new HttpError(401, 'Invalid email or password');
    }
    if (user.account_status !== 'active') {
      await db.query(
        `INSERT INTO user_access_events (user_id, email, event_type, ip_address, success, detail)
         VALUES ($1, $2, 'login', $3, FALSE, 'suspended account')`,
        [user.id, email, req.ip || null]
      );
      throw new HttpError(403, 'This account is suspended. Contact support if you believe this is a mistake.');
    }
    await db.query('UPDATE users SET last_login_at = NOW(), last_login_ip = $2, last_login_country = $3 WHERE id = $1', [user.id, req.ip || null, countryCode]);
    await db.query(
      `INSERT INTO user_access_events (user_id, email, event_type, ip_address, country_code, success)
       VALUES ($1, $2, 'login', $3, $4, TRUE)`,
      [user.id, email, req.ip || null, countryCode]
    );
    delete user.password;
    res.json({ user, token: tokenFor(user) });
  })
);

module.exports = router;
