const axios = require('axios');
const cheerio = require('cheerio');
const { normalizeUrl, domainFromUrl } = require('../utils/url');
const { requestPublicUrl } = require('../utils/safeFetch');

const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

const SKIP_DOMAINS = ['sentry.io','wixpress.com','shopify.com','shopifycdn.com','shopifyemails.com',
  'example.com','githubusercontent.com','cloudflare.com','google.com','facebook.com',
  'twitter.com','instagram.com','tiktok.com','youtube.com','amazon.com','klaviyo.com',
  'mailchimp.com','gorgias.com','zendesk.com','intercom.io','freshdesk.com','global-e.com',
  'hcaptcha.com','recaptcha.net','paypal.com','stripe.com'];

const SKIP_LOCALS = ['noreply','no-reply','webmaster','postmaster','mailer-daemon','bounce',
  'donotreply','do-not-reply','unsubscribe','abuse','spam','legal','dmca',
  'billing','invoice','notifications','alerts','newsletter','privacy'];

const PREFERRED_LOCALS = ['hello','hi','contact','sales','team','founder','owner','ceo',
  'director','marketing','partnerships','press','media','info','enquiries','enquiry',
  'shop','store','support','help','service','customer','order','orders','care'];

const LOCALES = ['en','fr','de','es','it','nl','pt','ja','zh','ko','ar','ru'];

const isImageFile = (email) => {
  const lower = email.toLowerCase();
  return /\.(png|jpg|jpeg|gif|webp|svg|ico|bmp|tiff|avif)/.test(lower) ||
         /@[0-9]+x\./.test(lower) ||
         /[0-9]+x@/.test(lower) ||
         /[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}/.test(lower);
};

const isValidEmail = (email) => {
  const [local, domain] = email.toLowerCase().split('@');
  if (!domain) return false;
  if (isImageFile(email)) return false;
  if (!/^[a-zA-Z0-9._%+-]+$/.test(local)) return false;
  if (local.length > 50) return false;
  if (!/\.[a-zA-Z]{2,}$/.test(domain)) return false;
  if (SKIP_DOMAINS.some(d => domain.includes(d))) return false;
  if (SKIP_LOCALS.includes(local)) return false;
  if (email.length > 80) return false;
  return true;
};

const chooseBestEmail = (emails) => {
  const valid = [...new Set(emails.map(e => e.toLowerCase()))].filter(isValidEmail);
  const preferred = valid.find(e => PREFERRED_LOCALS.includes(e.split('@')[0]));
  return preferred || valid[0] || null;
};

const fetchPage = async (url) => {
  try {
    const { data } = await requestPublicUrl(url, {
      method: 'GET',
      timeout: 10000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9'
      },
      maxRedirects: 5
    });
    return data;
  } catch {
    return null;
  }
};

const extractEmailsFromHtml = (html) => {
  if (!html) return [];
  const $ = cheerio.load(html);
  $('script[src], style, noscript, svg').remove();

  const found = [];

  // 1. mailto links
  $('a[href^="mailto:"]').each((_, el) => {
    const raw = $(el).attr('href').replace(/^mailto:/i, '').split('?')[0].trim();
    if (raw && raw.includes('@')) found.push(raw);
  });

  // 2. Body text
  found.push(...($('body').text().match(emailRegex) || []));

  // 3. Full HTML source
  found.push(...(html.match(emailRegex) || []));

  // 4. JSON-LD schema
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      found.push(...(JSON.stringify(JSON.parse($(el).html())).match(emailRegex) || []));
    } catch {}
  });

  // 5. Meta tags
  $('meta[content]').each((_, el) => {
    const content = $(el).attr('content') || '';
    found.push(...(content.match(emailRegex) || []));
  });

  // 6. Data attributes
  $('[data-email],[data-contact],[data-owner],[data-mail]').each((_, el) => {
    ['data-email','data-contact','data-owner','data-mail'].forEach(attr => {
      const val = $(el).attr(attr);
      if (val && val.includes('@')) found.push(val);
    });
  });

  return found;
};

// Detect site locale prefix from homepage
const detectLocale = async (baseUrl) => {
  try {
    const { request } = await requestPublicUrl(baseUrl, { method: 'GET', timeout: 8000, maxRedirects: 5 });
    const finalUrl = request.res?.responseUrl || '';
    const match = finalUrl.match(/\/([a-z]{2})(\/|$)/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
};

// Get sitemap pages
const getSitemapPages = async (baseUrl) => {
  try {
    const { data } = await requestPublicUrl(baseUrl + '/sitemap.xml', { method: 'GET', timeout: 8000 });
    const matches = data.match(/<loc>(.*?)<\/loc>/g) || [];
    return matches
      .map(m => m.replace(/<\/?loc>/g, '').trim())
      .filter(url =>
        url.includes('/pages/') ||
        url.includes('/contact') ||
        url.includes('/about') ||
        url.includes('/faq') ||
        url.includes('/privacy') ||
        url.includes('/terms') ||
        url.includes('/impressum') ||
        url.includes('/legal')
      )
      .slice(0, 15);
  } catch {
    return [];
  }
};

// Check security.txt
const getSecurityTxt = async (baseUrl) => {
  for (const path of ['/.well-known/security.txt', '/security.txt']) {
    try {
      const { data } = await requestPublicUrl(baseUrl + path, { method: 'GET', timeout: 5000 });
      const emails = data.match(emailRegex) || [];
      if (emails.length) return emails;
    } catch {}
  }
  return [];
};

const scrapeEmails = async (input) => {
  const baseUrl = normalizeUrl(input);
  const isShopify = input.includes('myshopify.com');

  // Detect locale prefix (e.g. /en/, /fr/)
  const locale = await detectLocale(baseUrl);
  const localePrefix = locale ? `/${locale}` : '';

  // Build path list with and without locale prefix
  const basePaths = [
    '/contact', '/contact-us', '/about', '/about-us',
    '/privacy-policy', '/faq', '/terms', '/terms-of-service',
    '/impressum', '/legal', '/help', '/support',
    '/pages/contact', '/pages/about', '/pages/faq',
    '/pages/contact-us', '/pages/about-us',
    '/info/contact', '/get-in-touch'
  ];

  const allPaths = ['/', ...basePaths];

  // Add locale-prefixed versions
  if (localePrefix) {
    basePaths.forEach(p => allPaths.push(localePrefix + p));
  }

  // Add Shopify-specific paths
  if (isShopify) {
    allPaths.push(
      '/pages/wholesale', '/pages/stockists', '/pages/press',
      '/pages/shipping', '/pages/returns', '/pages/privacy-policy'
    );
  }

  const allEmails = [];

  // Fetch all pages in parallel
  const pageHtmls = await Promise.all(
    [...new Set(allPaths)].map(path => {
      try { return fetchPage(new URL(path, baseUrl).toString()); }
      catch { return null; }
    })
  );

  for (const html of pageHtmls) {
    allEmails.push(...extractEmailsFromHtml(html));
  }

  // Check security.txt and sitemap in parallel
  const [securityEmails, sitemapPages] = await Promise.all([
    getSecurityTxt(baseUrl),
    getSitemapPages(baseUrl)
  ]);
  allEmails.push(...securityEmails);

  // Fetch sitemap pages
  if (sitemapPages.length > 0) {
    const sitemapHtmls = await Promise.all(
      sitemapPages.slice(0, 10).map(url => fetchPage(url))
    );
    for (const html of sitemapHtmls) {
      allEmails.push(...extractEmailsFromHtml(html));
    }
  }

  // Follow extra contact/about links from homepage
  const homepageHtml = pageHtmls[0];
  if (homepageHtml) {
    const $ = cheerio.load(homepageHtml);
    const extraPaths = [];
    $('a[href]').each((_, el) => {
      const href = ($(el).attr('href') || '').split('?')[0];
      const text = $(el).text().toLowerCase();
      if (
        href.startsWith('/') &&
        href.length < 80 &&
        !allPaths.includes(href) &&
        (text.includes('contact') || text.includes('about') ||
         text.includes('reach') || text.includes('email') ||
         text.includes('touch') || text.includes('connect') ||
         text.includes('wholesale') || text.includes('press') ||
         text.includes('stockist') || text.includes('faq') ||
         text.includes('privacy') || text.includes('legal') ||
         text.includes('impressum'))
      ) {
        extraPaths.push(href);
      }
    });

    if (extraPaths.length > 0) {
      const extraHtmls = await Promise.all(
        [...new Set(extraPaths)].slice(0, 8).map(path => {
          try { return fetchPage(new URL(path, baseUrl).toString()); }
          catch { return null; }
        })
      );
      for (const html of extraHtmls) {
        allEmails.push(...extractEmailsFromHtml(html));
      }
    }
  }

  return chooseBestEmail(allEmails);
};

const findEmailForDomain = async (input, hunterApiKey) => {
  const domain = domainFromUrl(input);

  // Try Hunter first if key available
  if (hunterApiKey) {
    try {
      const { data } = await axios.get('https://api.hunter.io/v2/domain-search', {
        params: { domain, api_key: hunterApiKey, limit: 10 },
        timeout: 10000
      });
      const emails = ((data.data && data.data.emails) || []).map(i => i.value).filter(Boolean);
      const email = chooseBestEmail(emails);
      if (email) return { email, source: 'Hunter', status: 'Found', flagged: false };
    } catch {}
  }

  // Deep locale-aware scrape
  const scrapedEmail = await scrapeEmails(input);
  if (scrapedEmail) {
    return { email: scrapedEmail, source: 'Scraped', status: 'Found', flagged: false };
  }

  return { email: null, source: 'Manual Review', status: 'Email Not Found', flagged: true };
};

module.exports = { findEmailForDomain };
