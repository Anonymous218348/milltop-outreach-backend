const express = require('express');
const { requireAuth } = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');
const { getAuthUrl, createOAuthState, consumeOAuthState, exchangeCode, disconnectGmail, isGmailConnected } = require('../services/gmail.service.js');

const router = express.Router();

// Get Gmail OAuth URL — called when user clicks "Connect Gmail"
router.get('/auth-url', requireAuth, asyncHandler(async (req, res) => {
  const state = await createOAuthState(req.user.id);
  const url = getAuthUrl(state);
  res.json({ url });
}));

// OAuth callback — Google redirects here after user authorizes
// Note: this route is NOT protected by requireAuth because the user
// isn't sending a JWT here — Google is redirecting with a code.
// The callback consumes the single-use state record created by /auth-url.
router.get('/callback', asyncHandler(async (req, res) => {
  const { code, error } = req.query;

  if (error) {
    return res.redirect(`${process.env.FRONTEND_URL || '/'}?gmail=denied`);
  }

  if (!code) {
    return res.redirect(`${process.env.FRONTEND_URL || '/'}?gmail=error`);
  }

  if (!req.query.state) {
    return res.redirect(`${process.env.FRONTEND_URL || '/'}?gmail=error&reason=no_state`);
  }
  const userId = await consumeOAuthState(req.query.state);
  if (!userId) {
    return res.redirect(`${process.env.FRONTEND_URL || '/'}?gmail=error&reason=invalid_state`);
  }

  await exchangeCode(code, userId);
  res.redirect(`${process.env.FRONTEND_URL || '/'}?gmail=connected`);
}));

// Check if Gmail is connected for current user
router.get('/status', requireAuth, asyncHandler(async (req, res) => {
  const connected = await isGmailConnected(req.user.id);
  res.json({ connected });
}));

// Disconnect Gmail
router.delete('/disconnect', requireAuth, asyncHandler(async (req, res) => {
  await disconnectGmail(req.user.id);
  res.json({ disconnected: true });
}));

module.exports = router;
