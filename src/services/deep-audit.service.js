const { requestPublicUrl } = require('../utils/safeFetch');
const cheerio = require('cheerio');
const { normalizeUrl } = require('../utils/url');

const runDeepAudit = async (inputUrl) => {
  const url = normalizeUrl(inputUrl).replace(/\/$/, '');
  const origin = new URL(url).origin;

  const findings = [];
  const pages = [];
  const seen = new Set();

  // Homepage/other catalog pages
  const queue = [url];

  // Collection pages get priority because they are commercially important.
  const collectionQueue = [];
  const deadline = Date.now() + 60000;
  const MAX_QUEUE = 60;
  const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

  const add = (severity, type, title, evidence, pageUrl) =>
    findings.push({
      severity,
      type,
      title,
      evidence,
      url: pageUrl
    });

  while ((collectionQueue.length || queue.length) && pages.length < 20 && Date.now() < deadline) {
    const pageUrl = collectionQueue.length
      ? collectionQueue.shift()
      : queue.shift();

    if (seen.has(pageUrl)) continue;
    seen.add(pageUrl);

    try {
      const response = await requestPublicUrl(pageUrl, {
        method: 'GET',
        timeout: 8000,
        maxRedirects: 4,
        maxContentLength: MAX_RESPONSE_BYTES,
        maxBodyLength: MAX_RESPONSE_BYTES,
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; MILLTOPTECH-Audit/1.0)'
        },
        validateStatus: status => status < 500
      });

      pages.push({
        url: pageUrl,
        status: response.status
      });

      if (response.status >= 400) {
        add(
          response.status >= 500 ? 'high' : 'medium',
          'broken',
          'Page returns HTTP ' + response.status,
          'The page returned HTTP ' + response.status + '.',
          pageUrl
        );

        continue;
      }

      if (typeof response.data !== 'string') continue;

      const $ = cheerio.load(response.data);

      const text = $('body')
        .text()
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();

      const pathname = new URL(pageUrl).pathname;
      const isCollection = /\/collections?\//i.test(pathname);

      // ─────────────────────────────────────────────
      // BASIC PAGE CHECKS
      // ─────────────────────────────────────────────

      if (!$('title').length || !$('title').text().trim()) {
        add(
          'medium',
          'seo',
          'Missing page title',
          'No title element was found.',
          pageUrl
        );
      }

      if (!$('meta[name="description"]').attr('content')) {
        add(
          'medium',
          'seo',
          'Missing meta description',
          'No meta description was found.',
          pageUrl
        );
      }

      if (!$('meta[name="viewport"]').attr('content')) {
        add(
          'medium',
          'ux',
          'Missing mobile viewport',
          'No viewport meta tag was found.',
          pageUrl
        );
      }

      if (!$('html').attr('lang')) {
        add(
          'low',
          'accessibility',
          'Missing document language',
          'The html element has no lang attribute.',
          pageUrl
        );
      }

      if (!$('link[rel="canonical"]').attr('href')) {
        add(
          'low',
          'seo',
          'Missing canonical URL',
          'No canonical link was found.',
          pageUrl
        );
      }

      if (
        $('img').filter((_, el) => !$(el).attr('alt')).length
      ) {
        add(
          'medium',
          'accessibility',
          'Images missing alt text',
          'At least one image has no alt attribute.',
          pageUrl
        );
      }

      // ─────────────────────────────────────────────
      // COMMERCE / COLLECTION CHECKS
      // ─────────────────────────────────────────────

      const productLinks = $('a[href*="/products/"]');

      const noProductsMessage =
        /no products found|no products|nothing found|0 products/.test(text);

      if (
        isCollection &&
        (
          noProductsMessage ||
          productLinks.length === 0
        ) &&
        !/add to cart|add to bag|buy now/.test(text)
      ) {
        add(
          'high',
          'commerce',
          'Collection page appears empty',
          noProductsMessage
            ? 'The collection page contains a no-products message.'
            : 'The collection page contains no product links in the returned HTML.',
          pageUrl
        );
      }

      // ─────────────────────────────────────────────
      // DISCOVER INTERNAL CATALOG LINKS
      // ─────────────────────────────────────────────

      $('a[href]').each((_, el) => {
        try {
          const href = $(el).attr('href');

          if (!href) return;

          const next = new URL(href, pageUrl);

          next.hash = '';

          if (
            next.origin !== origin ||
            seen.has(next.href)
          ) {
            return;
          }

          if (
            !/\/(collections?|products?|shop|category|pages)\//i.test(
              next.pathname
            )
          ) {
            return;
          }

          // Collections are checked before other pages.
          if (/\/collections?\//i.test(next.pathname)) {
            if (!collectionQueue.includes(next.href) && collectionQueue.length < MAX_QUEUE) {
              collectionQueue.push(next.href);
            }
          } else {
            if (!queue.includes(next.href) && queue.length < MAX_QUEUE) {
              queue.push(next.href);
            }
          }
        } catch {
          // Ignore malformed links.
        }
      });
    } catch (err) {
      pages.push({
        url: pageUrl,
        status: 0
      });

      add(
        'medium',
        'broken',
        'Page failed to load',
        err.message,
        pageUrl
      );
    }
  }

  // ─────────────────────────────────────────────
  // REMOVE DUPLICATE FINDINGS
  // ─────────────────────────────────────────────

  const unique = [];
  const keys = new Set();

  for (const finding of findings) {
    const key =
      finding.type +
      '|' +
      finding.title +
      '|' +
      finding.url;

    if (!keys.has(key)) {
      keys.add(key);
      unique.push(finding);
    }
  }

  // ─────────────────────────────────────────────
  // DETERMINE OVERALL PRIORITY
  // ─────────────────────────────────────────────

  const priority = unique.some(
    f => f.severity === 'high'
  )
    ? 'HIGH'
    : unique.some(
        f => f.severity === 'medium'
      )
      ? 'MEDIUM'
      : unique.length
        ? 'LOW'
        : 'NONE';

  return {
    priority,
    findings: unique.slice(0, 30),
    pages: pages.length
  };
};

module.exports = {
  runDeepAudit
};
