const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');

const { errorHandler, notFoundHandler } = require('./middleware/error');
const authRoutes = require('./routes/auth.routes');
const scannerRoutes = require('./routes/scanner.routes');
const finderRoutes = require('./routes/finder.routes');
const contactsRoutes = require('./routes/contacts.routes');
const templatesRoutes = require('./routes/templates.routes');
const campaignsRoutes = require('./routes/campaigns.routes');
const emailRoutes = require('./routes/email.routes');
const analyticsRoutes = require('./routes/analytics.routes');
const crmRoutes = require('./routes/crm.routes');
const trackerRoutes = require('./routes/tracker.routes');
const aiRoutes = require('./routes/ai.routes');
const settingsRoutes = require('./routes/settings.routes');
const telegramRoutes = require('./routes/telegram.routes');
const gmailRoutes = require('./routes/gmail.routes.js');
const adminRoutes = require('./routes/admin.routes');

const app = express();

const corsOrigins = (process.env.CORS_ORIGIN || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

if (process.env.NODE_ENV === 'production' && corsOrigins.length === 0) {
  throw new Error('CORS_ORIGIN must list the production frontend origin(s)');
}

app.use(helmet());
app.use(cors({
  origin(origin, callback) {
    if (!origin || (process.env.NODE_ENV !== 'production' && corsOrigins.length === 0) || corsOrigins.includes(origin)) {
      callback(null, true);
      return;
    }
    callback(null, false);
  },
  credentials: true
}));
app.use(express.json({
  limit: '1mb',
  verify: (req, _res, buffer) => { req.rawBody = Buffer.from(buffer); }
}));
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));
// Render places the service behind a managed proxy chain. Trust the forwarded
// client address supplied by that platform so req.ip does not record an
// internal 10.x proxy address. Do not reuse this setting on an untrusted host.
app.set('trust proxy', true);
app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 500,
  standardHeaders: true,
  legacyHeaders: false
}));

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'MILLTOP TECH API' });
});

app.use('/api/auth', authRoutes);
app.use('/api/scanner', scannerRoutes);
app.use('/api/finder', finderRoutes);
app.use('/api/contacts', contactsRoutes);
app.use('/api/templates', templatesRoutes);
app.use('/api/campaigns', campaignsRoutes);
app.use('/api/email', emailRoutes);
app.use('/api/webhooks', require('./routes/webhooks.routes'));
app.use('/api/analytics', analyticsRoutes);
app.use('/api/crm', crmRoutes);
app.use('/api/tracker', trackerRoutes);
app.use('/api/ai', aiRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/telegram', telegramRoutes);
app.use('/api/gmail', gmailRoutes);
app.use('/api/admin', adminRoutes);

app.use(notFoundHandler);
app.use(errorHandler);

module.exports = app;
