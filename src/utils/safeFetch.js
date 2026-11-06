const axios = require('axios');
const dns = require('dns').promises;
const net = require('net');
const http = require('http');
const https = require('https');

const blockedIPv4 = (address) => {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some(part => part < 0 || part > 255)) return true;
  const [a, b, c] = parts;
  return a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 168 || (b === 0 && c === 0) || (b === 0 && c === 2))) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113);
};

const isPublicAddress = (address) => {
  const family = net.isIP(address);
  if (family === 4) return !blockedIPv4(address);
  if (family !== 6) return false;
  const value = address.toLowerCase().split('%')[0];
  const mapped = value.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPublicAddress(mapped[1]);
  if (value === '::' || value === '::1' || value.startsWith('fc') || value.startsWith('fd') ||
      /^fe[89ab]/.test(value) || value.startsWith('ff') || value.startsWith('2001:db8:')) return false;
  return true;
};

const lookupPublic = async (hostname) => {
  const addresses = net.isIP(hostname)
    ? [{ address: hostname, family: net.isIP(hostname) }]
    : await dns.lookup(hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(record => !isPublicAddress(record.address))) {
    throw new Error('URL resolves to a non-public network address');
  }
  return addresses[0];
};

const requestPublicUrl = async (input, options = {}) => {
  let target = new URL(input);
  if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) {
    throw new Error('Only public HTTP and HTTPS URLs are allowed');
  }

  const maxRedirects = Math.min(Number(options.maxRedirects ?? 3), 5);
  for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
    const resolved = await lookupPublic(target.hostname);
    const pinnedLookup = (_hostname, lookupOptions, callback) => {
      if (lookupOptions && lookupOptions.all) callback(null, [resolved]);
      else callback(null, resolved.address, resolved.family);
    };
    const response = await axios.request({
      ...options,
      url: target.href,
      maxRedirects: 0,
      proxy: false,
      httpAgent: new http.Agent({ lookup: pinnedLookup }),
      httpsAgent: new https.Agent({ lookup: pinnedLookup }),
      maxContentLength: options.maxContentLength ?? 2 * 1024 * 1024,
      maxBodyLength: options.maxBodyLength ?? 2 * 1024 * 1024,
      validateStatus: () => true
    });

    if (![301, 302, 303, 307, 308].includes(response.status) || !response.headers.location) return response;
    if (redirectCount === maxRedirects) throw new Error('Too many redirects');
    target = new URL(response.headers.location, target);
    if (!['http:', 'https:'].includes(target.protocol)) throw new Error('Redirected to a non-HTTP URL');
    if (response.status === 303) options.method = 'GET';
  }
  throw new Error('Too many redirects');
};

module.exports = { requestPublicUrl, isPublicAddress };
