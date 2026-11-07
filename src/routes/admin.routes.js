const express = require('express');
const { body, param, query } = require('express-validator');
const db = require('../db');
const asyncHandler = require('../utils/asyncHandler');
const { requireAuth } = require('../middleware/auth');
const { validate } = require('../utils/validation');
const { HttpError } = require('../utils/httpError');

const router = express.Router();
const inTransaction = async (work) => {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};
router.use(requireAuth, (req, _res, next) => {
  if (req.user.role !== 'admin') return next(new HttpError(403, 'Admin access required'));
  next();
});

router.get('/overview', asyncHandler(async (_req, res) => {
  const { rows } = await db.query(`
    SELECT COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE account_status='active')::int AS active,
      COUNT(*) FILTER (WHERE account_status='suspended')::int AS suspended,
      COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '30 days')::int AS signups_30d
    FROM users`);
  const { rows: recent } = await db.query(`SELECT id, email, event_type, ip_address::text AS ip_address, country_code,
      anonymizer_status, success, created_at FROM user_access_events ORDER BY created_at DESC LIMIT 12`);
  res.json({ summary: rows[0], recent, countryDetectionEnabled: process.env.TRUST_CLOUDFLARE_IP_COUNTRY === 'true' });
}));

router.get('/country-rules', asyncHandler(async (_req, res) => {
  const { rows } = await db.query('SELECT country_code, blocked, reason, updated_at FROM admin_country_rules ORDER BY country_code');
  res.json({ rules: rows, detectionEnabled: process.env.TRUST_CLOUDFLARE_IP_COUNTRY === 'true' });
}));

router.put('/country-rules/:code', param('code').isLength({ min: 2, max: 2 }).isAlpha().toUpperCase(),
  body('blocked').isBoolean(), body('reason').optional().isString().trim().isLength({ max: 500 }), validate,
  asyncHandler(async (req, res) => {
    const code = req.params.code.toUpperCase();
    await db.query(`INSERT INTO admin_country_rules(country_code,blocked,reason,updated_by,updated_at)
      VALUES($1,$2,$3,$4,NOW()) ON CONFLICT(country_code) DO UPDATE SET
      blocked=EXCLUDED.blocked,reason=EXCLUDED.reason,updated_by=EXCLUDED.updated_by,updated_at=NOW()`,
      [code, req.body.blocked, req.body.reason || '', req.user.id]);
    await db.query(`INSERT INTO admin_audit_logs(actor_user_id,action,reason,metadata)
      VALUES($1,'country_rule.update',$2,jsonb_build_object('country_code',$3::text,'blocked',$4::boolean))`,
      [req.user.id, req.body.reason || '', code, req.body.blocked]);
    res.json({ ok: true });
  })
);

router.get('/users', query('q').optional().isString().isLength({ max: 150 }), validate,
  asyncHandler(async (req, res) => {
    const term = (req.query.q || '').trim();
    const { rows } = await db.query(`
      SELECT u.id, u.email, u.role, u.account_status, u.suspended_at, u.suspension_reason, u.created_at, u.last_login_at,
        u.signup_ip::text AS signup_ip, u.last_login_ip::text AS last_login_ip,
        u.signup_country, u.last_login_country,
        (SELECT COUNT(*)::int FROM user_access_events e WHERE e.user_id=u.id AND e.event_type='login' AND NOT e.success) AS failed_logins
      FROM users u WHERE ($1='' OR u.email ILIKE '%' || $1 || '%')
      ORDER BY u.created_at DESC LIMIT 200`, [term]);
    res.json({ users: rows });
  })
);

router.get('/events', asyncHandler(async (req, res) => {
  const { rows } = await db.query(`SELECT id, user_id, email, event_type, ip_address::text AS ip_address,
      country_code, anonymizer_status, success, detail, created_at
    FROM user_access_events ORDER BY created_at DESC LIMIT 250`);
  res.json({ events: rows });
}));

router.post('/users/:id/suspend', param('id').isUUID(), body('reason').isString().trim().isLength({ min: 3, max: 500 }), validate,
  asyncHandler(async (req, res) => {
    const target = await inTransaction(async (client) => {
      const { rows } = await client.query('SELECT id, email, role FROM users WHERE id=$1 FOR UPDATE', [req.params.id]);
      const account = rows[0];
      if (!account) throw new HttpError(404, 'Account not found');
      if (account.id === req.user.id) throw new HttpError(400, 'You cannot suspend your own admin account');
      if (account.role === 'admin') throw new HttpError(400, 'Admin accounts cannot be suspended here');
      await client.query("UPDATE users SET account_status='suspended', suspended_at=NOW(), suspension_reason=$2 WHERE id=$1", [account.id, req.body.reason]);
      await client.query(`INSERT INTO admin_audit_logs (actor_user_id, target_user_id, action, reason, metadata)
        VALUES ($1,$2,'account.suspend',$3,jsonb_build_object('email',$4::text))`, [req.user.id, account.id, req.body.reason, account.email]);
      return account;
    });
    res.json({ ok: true, message: 'Account suspended' });
  })
);

router.post('/users/:id/restore', param('id').isUUID(), body('reason').optional().isString().trim().isLength({ max: 500 }), validate,
  asyncHandler(async (req, res) => {
    await inTransaction(async (client) => {
      const { rows } = await client.query('SELECT id,email FROM users WHERE id=$1 FOR UPDATE', [req.params.id]);
      if (!rows[0]) throw new HttpError(404, 'Account not found');
      await client.query("UPDATE users SET account_status='active', suspended_at=NULL, suspension_reason=NULL WHERE id=$1", [req.params.id]);
      await client.query(`INSERT INTO admin_audit_logs (actor_user_id,target_user_id,action,reason,metadata)
        VALUES ($1,$2,'account.restore',$3,jsonb_build_object('email',$4::text))`, [req.user.id, req.params.id, req.body.reason || '', rows[0].email]);
    });
    res.json({ ok: true, message: 'Account restored' });
  })
);

router.get('/audit', asyncHandler(async (_req, res) => {
  const { rows } = await db.query(`SELECT a.id,a.action,a.reason,a.metadata,a.created_at,
      actor.email AS actor_email,target.email AS target_email
    FROM admin_audit_logs a LEFT JOIN users actor ON actor.id=a.actor_user_id
    LEFT JOIN users target ON target.id=a.target_user_id ORDER BY a.created_at DESC LIMIT 250`);
  res.json({ audit: rows });
}));

router.get('/suspensions', asyncHandler(async (_req, res) => {
  const { rows } = await db.query(`SELECT a.id, a.action, a.reason, a.created_at,
      actor.email AS actor_email, target.email AS target_email
    FROM admin_audit_logs a
    LEFT JOIN users actor ON actor.id=a.actor_user_id
    LEFT JOIN users target ON target.id=a.target_user_id
    WHERE a.action IN ('account.suspend','account.restore')
    ORDER BY a.created_at DESC LIMIT 250`);
  res.json({ history: rows });
}));

router.get('/appeals', asyncHandler(async (_req, res) => {
  const { rows } = await db.query(`SELECT a.id,a.email,a.message,a.status,a.resolution,a.created_at,
      a.reviewed_at,reviewer.email AS reviewer_email,u.account_status
    FROM account_appeals a JOIN users u ON u.id=a.user_id
    LEFT JOIN users reviewer ON reviewer.id=a.reviewed_by
    WHERE a.status='open' ORDER BY a.created_at ASC LIMIT 200`);
  res.json({ appeals: rows });
}));

router.post('/appeals/:id/resolve', param('id').isUUID(),
  body('decision').isIn(['restore','dismiss']),
  body('resolution').isString().trim().isLength({ min: 3, max: 1000 }), validate,
  asyncHandler(async (req, res) => {
    const status = req.body.decision === 'restore' ? 'restored' : 'dismissed';
    await inTransaction(async (client) => {
      const { rows } = await client.query('SELECT id,user_id,email FROM account_appeals WHERE id=$1 AND status=\'open\' FOR UPDATE', [req.params.id]);
      const appeal = rows[0];
      if (!appeal) throw new HttpError(404, 'Open appeal not found');
      if (req.body.decision === 'restore') {
        await client.query("UPDATE users SET account_status='active',suspended_at=NULL,suspension_reason=NULL WHERE id=$1", [appeal.user_id]);
      }
      await client.query(`UPDATE account_appeals SET status=$2,resolution=$3,reviewed_at=NOW(),reviewed_by=$4 WHERE id=$1`,
        [appeal.id, status, req.body.resolution.trim(), req.user.id]);
      await client.query(`INSERT INTO admin_audit_logs(actor_user_id,target_user_id,action,reason,metadata)
        VALUES($1,$2,$3,$4,jsonb_build_object('email',$5::text,'appeal_id',$6::text))`,
        [req.user.id, appeal.user_id, `account.appeal.${status}`, req.body.resolution.trim(), appeal.email, appeal.id]);
    });
    res.json({ ok: true, status });
  })
);

module.exports = router;
