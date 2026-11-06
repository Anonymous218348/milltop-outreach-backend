const axios = require('axios');
const nodemailer = require('nodemailer');
const crypto = require('crypto');
const db = require('../db');
const { delay } = require('../utils/delay');
const { getSettings } = require('./settings.service');

// Replaces all known placeholder formats with actual values
const personalize = (text, data = {}) => {
  let out = String(text || '');
  const sn = data.storeName || data.store_name || data.domain || data.name || '';
  const score = data.mobileScore == null ? '' : String(data.mobileScore);

  // {{variable}} and {variable} formats
  out = out.replace(/\{\{?\s*name\s*\}?\}/gi, data.name || sn);
  out = out.replace(/\{\{?\s*first_name\s*\}?\}/gi, (data.name || sn).split(' ')[0]);
  out = out.replace(/\{\{?\s*store[_\s]?name\s*\}?\}/gi, sn);
  out = out.replace(/\{\{?\s*domain\s*\}?\}/gi, data.domain || sn);
  out = out.replace(/\{\{?\s*email\s*\}?\}/gi, data.email || '');
  out = out.replace(/\{\{?\s*website\s*\}?\}/gi, data.website || '');
  out = out.replace(/\{\{?\s*phone\s*\}?\}/gi, data.phone || '');
  out = out.replace(/\{\{?\s*mobile[_\s]?score\s*\}?\}/gi, score);
  out = out.replace(/\{\{?\s*pagespeed[_\s]?score\s*\}?\}/gi, score);

  // [store name], [storeName] formats (AI-generated templates)
  out = out.replace(/\[store\s*name\]/gi, sn);
  out = out.replace(/\[storeName\]/gi, sn);
  out = out.replace(/\[mobile\s*score\]/gi, score);
  out = out.replace(/\[mobileScore\]/gi, score);

  return out;
};

const logEmail = async ({ userId, storeId, contactId, campaignId, subject, body, status, sentAt, storeName, toEmail, provider, providerMessageId }) => {
  const { rows } = await db.query(
    `INSERT INTO email_logs 
    (user_id, store_id, contact_id, campaign_id, subject, body, status, sent_at, store_name, to_email, provider, provider_message_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
    RETURNING *`,
    [
      userId,
      storeId || null,
      contactId || null,
      campaignId || null,
      subject,
      body,
      status,
      sentAt || null,
      storeName || null,
      toEmail || null,
      provider || null,
      providerMessageId || null
    ]
  );
  return rows[0];
};

const deliver = async ({ settings, accounts, fromAccount, to, subject, body }) => {
  const messageId = `<${crypto.randomUUID()}@commandcore.milltoptech>`;
  const selectedAccount = accounts.find(account => account.email === fromAccount) || (accounts.length === 1 ? accounts[0] : null);
  const provider = settings.email_provider || (selectedAccount ? 'gmail' : settings.sendgrid_api_key ? 'sendgrid' : settings.mailgun_api_key ? 'mailgun' : 'gmail');

  if (provider === 'gmail') {
    if (!selectedAccount) throw new Error(accounts.length ? 'Select a Gmail account to send from' : 'Gmail is selected. Add a Gmail account and App Password in Settings first.');
    if (!selectedAccount.pass) throw new Error(`SMTP password is missing for ${selectedAccount.email}; remove and add the account again`);
    const transporter = nodemailer.createTransport({
      host: 'smtp.gmail.com', port: 465, secure: true,
      auth: { user: selectedAccount.email, pass: selectedAccount.pass }
    });
    await transporter.sendMail({ from: selectedAccount.email, to, subject, text: body.replace(/<[^>]*>/g, ''), html: body, messageId });
    return { provider: 'gmail', from: selectedAccount.email, messageId };
  }

  if (provider === 'sendgrid') {
    if (!settings.sendgrid_api_key) throw new Error('SendGrid is selected. Add your SendGrid API key in Settings first.');
    if (!settings.sendgrid_from) throw new Error('A verified sender email is required for SendGrid');
    const message = {
      personalizations: [{ to: [{ email: to }] }],
      from: { email: settings.sendgrid_from, name: settings.sendgrid_name || 'Milltop Tech' },
      subject,
      headers: { 'Message-ID': messageId },
      content: [{ type: 'text/plain', value: body.replace(/<[^>]*>/g, '') }, { type: 'text/html', value: body }]
    };
    if (settings.sendgrid_template_id) {
      message.template_id = settings.sendgrid_template_id;
      message.dynamic_template_data = { subject, message: body };
      delete message.content;
    }
    await axios.post('https://api.sendgrid.com/v3/mail/send', message, {
      headers: { Authorization: `Bearer ${settings.sendgrid_api_key}`, 'Content-Type': 'application/json' }, timeout: 15000
    });
    return { provider: 'sendgrid', from: settings.sendgrid_from, messageId };
  }

  if (provider === 'mailgun' && settings.mailgun_api_key && settings.mailgun_domain && settings.mailgun_from) {
    const params = new URLSearchParams({ from: settings.mailgun_from, to, subject, text: body.replace(/<[^>]*>/g, ''), html: body, 'h:Message-Id': messageId });
    await axios.post(`https://api.mailgun.net/v3/${encodeURIComponent(settings.mailgun_domain)}/messages`, params, {
      auth: { username: 'api', password: settings.mailgun_api_key },
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 15000
    });
    return { provider: 'mailgun', from: settings.mailgun_from, messageId };
  }

  if (provider === 'mailgun') throw new Error('Mailgun is selected. Complete its configuration in Settings first.');
  throw new Error('Choose Gmail or SendGrid in Settings before sending.');
};

const sendOne = async ({ userId, to, subject, body, storeId, contactId, campaignId, storeName, data = {}, fromAccount }) => {
  const settings = await getSettings(userId) || {};
  const accounts = Array.isArray(settings.gmail_accounts) ? settings.gmail_accounts : [];

  // Merge storeName into data so personalize() works for all formats
  const mergedData = {
    storeName,
    name: storeName,
    domain: storeName,
    ...data
  };

  // Personalize subject and body regardless of sending mode
  const personalizedSubject = personalize(subject, mergedData);
  const personalizedBody = personalize(body, mergedData);

  let provider = 'unknown';
  let providerMessageId = null;
  try {
    const delivery = await deliver({ settings, accounts, fromAccount, to, subject: personalizedSubject, body: personalizedBody });
    provider = delivery.provider;
    providerMessageId = delivery.messageId;

    return logEmail({
      userId,
      storeId,
      contactId,
      campaignId,
      subject: personalizedSubject,
      body: personalizedBody,
      status: 'sent',
      sentAt: new Date(),
      storeName,
      toEmail: to,
      provider,
      providerMessageId
    });

  } catch (error) {
    const errMsg = error?.response?.body?.errors?.[0]?.message || error.message;

    try {
      await logEmail({
        userId,
        storeId,
        contactId,
        campaignId,
        subject: personalizedSubject,
        body: personalizedBody,
        status: `failed: ${errMsg}`,
        storeName,
        toEmail: to,
        provider,
        providerMessageId
      });
    } catch (logError) {
      console.error('Failed to log email failure:', logError);
    }

    throw new Error(errMsg);
  }
};

const sendBulk = async ({ userId, contacts, subject, body, delayMs = 500, campaignId, accounts = [] }) => {
  const results = [];

  for (let index = 0; index < contacts.length; index += 1) {
    const contact = contacts[index];

    const data = {
      name: contact.name || contact.store_name,
      storeName: contact.store_name,
      email: contact.email,
      website: contact.website,
      phone: contact.phone,
      domain: contact.domain,
      mobileScore: contact.mobile_score
    };

    try {
      const log = await sendOne({
        userId,
        to: contact.email,
        subject,
        body,
        storeId: contact.store_id,
        contactId: contact.id,
        campaignId,
        storeName: contact.store_name,
        fromAccount: accounts.length ? accounts[index % accounts.length].email : undefined,
        data
      });

      results.push({ contactId: contact.id, status: 'sent', log });

    } catch (error) {
      results.push({ contactId: contact.id, status: 'failed', message: error.message });
    }

    if (index < contacts.length - 1) {
      await delay(Number(delayMs) || 500);
    }
  }

  return results;
};

module.exports = { personalize, sendOne, sendBulk };
