const { google } = require('googleapis');
const crypto = require('crypto');
const db = require('../db');

const getOAuthClient = () => new google.auth.OAuth2(
  process.env.GMAIL_CLIENT_ID,
  process.env.GMAIL_CLIENT_SECRET,
  process.env.GMAIL_REDIRECT_URI
);

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly'
];

const getAuthUrl = (state) => {
  const client = getOAuthClient();
  return client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: SCOPES,
    state
  });
};

const createOAuthState = async (userId) => {
  const state = crypto.randomBytes(32).toString('base64url');
  const tokenHash = crypto.createHash('sha256').update(state).digest('hex');
  await db.query('DELETE FROM gmail_oauth_states WHERE expires_at < NOW()');
  await db.query(
    'INSERT INTO gmail_oauth_states (token_hash, user_id, expires_at) VALUES ($1,$2,NOW() + INTERVAL \'10 minutes\')',
    [tokenHash, userId]
  );
  return state;
};

const consumeOAuthState = async (state) => {
  if (typeof state !== 'string' || state.length > 128) return null;
  const tokenHash = crypto.createHash('sha256').update(state).digest('hex');
  const { rows } = await db.query(
    'DELETE FROM gmail_oauth_states WHERE token_hash=$1 AND expires_at > NOW() RETURNING user_id',
    [tokenHash]
  );
  return rows[0]?.user_id || null;
};

const exchangeCode = async (code, userId) => {
  const client = getOAuthClient();
  const { tokens } = await client.getToken(code);

  await db.query(
    `UPDATE user_settings
     SET gmail_access_token=$1, gmail_refresh_token=$2, gmail_token_expiry=$3
     WHERE user_id=$4`,
    [tokens.access_token, tokens.refresh_token, tokens.expiry_date, userId]
  );

  return tokens;
};

const getAuthenticatedClient = async (userId) => {
  const { rows } = await db.query(
    'SELECT gmail_access_token, gmail_refresh_token, gmail_token_expiry FROM user_settings WHERE user_id=$1',
    [userId]
  );

  const settings = rows[0];
  if (!settings?.gmail_refresh_token) {
    throw new Error('Gmail not connected — please connect in Settings');
  }

  const client = getOAuthClient();
  client.setCredentials({
    access_token: settings.gmail_access_token,
    refresh_token: settings.gmail_refresh_token,
    expiry_date: settings.gmail_token_expiry
  });

  client.on('tokens', async (tokens) => {
    await db.query(
      `UPDATE user_settings
       SET gmail_access_token=$1, gmail_token_expiry=$2
       WHERE user_id=$3`,
      [tokens.access_token, tokens.expiry_date, userId]
    );
  });

  return client;
};

const disconnectGmail = async (userId) => {
  await db.query(
    `UPDATE user_settings
     SET gmail_access_token=NULL, gmail_refresh_token=NULL, gmail_token_expiry=NULL
     WHERE user_id=$1`,
    [userId]
  );
};

const isGmailConnected = async (userId) => {
  const { rows } = await db.query(
    'SELECT gmail_refresh_token FROM user_settings WHERE user_id=$1',
    [userId]
  );
  return !!(rows[0]?.gmail_refresh_token);
};

// Check Gmail for actual replies (using In-Reply-To/References headers)
// to emails we sent. Only marks replied='Yes' when the incoming message
// is a genuine thread reply, not just any email from that address.
const pollReplies = async (userId) => {
  try {
    const client = await getAuthenticatedClient(userId);
    const gmail = google.gmail({ version: 'v1', auth: client });

    // Get sent emails that haven't been replied to, with their subjects
    const { rows: sentEmails } = await db.query(
      `SELECT id, to_email, subject, sent_at, provider_message_id FROM email_logs
       WHERE user_id=$1 AND status='sent' AND replied IS DISTINCT FROM 'Yes'
       AND sent_at > NOW() - INTERVAL '30 days'`,
      [userId]
    );

    if (sentEmails.length === 0) return;

    // Build lookup: normalised email address -> list of log entries
    const byEmail = {};
    for (const log of sentEmails) {
      const addr = (log.to_email || '').toLowerCase().trim();
      if (!addr) continue;
      if (!byEmail[addr]) byEmail[addr] = [];
      byEmail[addr].push(log);
    }

    const senderAddresses = Object.keys(byEmail);
    if (senderAddresses.length === 0) return;

    // Search Gmail inbox for messages from those senders that arrived
    // AFTER we sent our email (avoids matching older unrelated threads)
    const query = `from:(${senderAddresses.join(' OR ')}) in:inbox`;

    const listRes = await gmail.users.messages.list({
      userId: 'me',
      q: query,
      maxResults: 100
    });

    const messages = listRes.data.messages || [];
    if (messages.length === 0) return;

    for (const msg of messages) {
      const detail = await gmail.users.messages.get({
        userId: 'me',
        id: msg.id,
        format: 'metadata',
        metadataHeaders: ['From', 'Subject', 'In-Reply-To', 'References', 'Date']
      });

      const headers = detail.data.payload?.headers || [];
      const getHeader = (name) => headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value || '';

      const from        = getHeader('From');
      const subject     = getHeader('Subject');
      const inReplyTo   = getHeader('In-Reply-To');
      const references  = getHeader('References');
      const dateStr     = getHeader('Date');

      // Extract sender email address
      const fromEmail = (from.match(/<([^>]+)>/) || [])[1] || from.trim();
      const fromEmailNorm = fromEmail.toLowerCase().trim();

      // Must be from a sender we emailed
      const logsForSender = byEmail[fromEmailNorm];
      if (!logsForSender || logsForSender.length === 0) continue;

      // STRICT CHECK: must have In-Reply-To or References header set —
      // genuine email replies always have at least one of these.
      // A cold inbound email (newsletter, unrelated contact) won't have them.
      const isActualReply = !!(inReplyTo || references);
      if (!isActualReply) continue;

      // Additional check: the reply subject should loosely match one of our
      // sent subjects (Re: Quick fix to boost...) or arrive after we sent it.
      const replyDate = dateStr ? new Date(dateStr).getTime() : 0;

      const normalizedReplySubject = subject.replace(/^(\s*(re|fw|fwd):\s*)+/i, '').trim().toLowerCase();
      const referencedIds = `${inReplyTo} ${references}`.toLowerCase();
      const relatedLogs = logsForSender.filter(log => {
        const sentDate = log.sent_at ? new Date(log.sent_at).getTime() : 0;
        if (replyDate && sentDate && replyDate < sentDate) return false;
        if (log.provider_message_id && referencedIds.includes(log.provider_message_id.toLowerCase())) return true;
        const sentSubject = String(log.subject || '').replace(/^(\s*(re|fw|fwd):\s*)+/i, '').trim().toLowerCase();
        return sentSubject && normalizedReplySubject === sentSubject;
      }).sort((a, b) => new Date(b.sent_at || 0) - new Date(a.sent_at || 0));

      // A reply belongs to the directly referenced message when possible;
      // otherwise use the most recent prior email with the same normalized subject.
      const exactMatch = relatedLogs.find(log => log.provider_message_id && referencedIds.includes(log.provider_message_id.toLowerCase()));
      const matchedLog = exactMatch || relatedLogs[0];
      if (matchedLog) {
        await db.query(
          `UPDATE email_logs SET replied='Yes', replied_at=NOW()
           WHERE id=$1 AND replied IS DISTINCT FROM 'Yes'`,
          [matchedLog.id]
        );
        console.log(`Reply confirmed from ${fromEmail} for log ${matchedLog.id}`);
      }
    }
  } catch (err) {
    console.error(`Reply poll error for user ${userId}:`, err.message);
  }
};

module.exports = { getAuthUrl, createOAuthState, consumeOAuthState, exchangeCode, getAuthenticatedClient, disconnectGmail, isGmailConnected, pollReplies };
