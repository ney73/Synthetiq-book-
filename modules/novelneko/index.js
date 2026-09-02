'use strict';

/*
 * Synthetiq Books — NovelNeko source module
 *
 * Source:
 *   https://novelneko.fr/
 *
 * Stable family:
 *   novelneko-v1
 *
 * Notes:
 * - Direct HTTPS requests only.
 * - No credentials, cookies, telemetry, filesystem, eval, or downloaded code.
 * - The NovelNeko reader currently exposes a lecture.html shell whose
 *   underlying .txt endpoint was not observable from the public HTML.
 * - Therefore extractText only accepts text that is actually present in the
 *   fetched reader response; it never guesses a .txt URL.
 */

const BASE_URL = 'https://novelneko.fr';
const ALLOWED_HOSTS = new Set(['novelneko.fr']);

const MAX_HTML_BYTES = 2_000_000;
const MAX_TEXT_BYTES = 5_000_000;
const MAX_RESULTS = 50;
const MAX_PAGE = 100;

const BLOCKED_MARKERS = [
  'captcha',
  'cloudflare',
  'access denied',
  'verify you are human',
  'login required',
  'connexion requise',
  'erreur de chargement',
  'impossible de charger le chapitre',
];

function getGlobal() {
  return typeof globalThis !== 'undefined' ? globalThis : {};
}

function assertRuntime() {
  const g = getGlobal();

  if (typeof g.fetchv2 !== 'function') {
    throw new Error('NovelNeko: fetchv2 is unavailable');
  }

  return g;
}

function normalizeWhitespace(value) {
  return String(value || '')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function decodeEntities(value) {
  return String(value || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_, n) => {
      const code = Number(n);
      return Number.isFinite(code) ? String.fromCodePoint(code) : _;
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => {
      const code = parseInt(n, 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : _;
    });
}

function stripHTML(html) {
  return normalizeWhitespace(
    decodeEntities(
      String(html || '')
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, '')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/(p|div|section|article|h[1-6]|li|blockquote)>/gi, '\n')
        .replace(/<[^>]+>/g, ' ')
    )
  );
}

function htmlAttribute(html, attribute) {
  const escaped = attribute.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(
    `\\b${escaped}\\s*=\\s*["']([^"']*)["']`,
    'i'
  );

  const match = String(html || '').match(re);
  return match ? decodeEntities(match[1]) : '';
}

function absoluteURL(rawURL, base = BASE_URL) {
  if (!rawURL) return null;

  try {
    const url = new URL(rawURL, base);

    if (url.protocol !== 'https:') {
      throw new Error('Only HTTPS URLs are allowed');
    }

    if (!ALLOWED_HOSTS.has(url.hostname.toLowerCase())) {
      throw new Error(`Host not allowed: ${url.hostname}`);
    }

    return url.href;
  } catch {
    return null;
  }
}

function assertAllowedURL(rawURL) {
  const url = absoluteURL(rawURL);

  if (!url) {
    throw new Error('NovelNeko: invalid or disallowed URL');
  }

  return url;
}

function isBlockedPage(body) {
  const text = normalizeWhitespace(stripHTML(body)).toLowerCase();

  return BLOCKED_MARKERS.some((marker) => text.includes(marker));
}

async function fetchHTML(url, options = {}) {
  const g = assertRuntime();
  const target = assertAllowedURL(url);

  const response = await g.fetchv2(target, {
    method: 'GET',
    headers: {
      Accept: 'text/html,application/xhtml+xml',
      'Accept-Language': 'fr-FR,fr;q=0.9',
      ...(options.headers || {}),
    },
    maxBytesHint: options.maxBytesHint || MAX_HTML_BYTES,
    responseClass: 'html',
  });

  if (!response || typeof response !== 'object') {
    throw new Error('NovelNeko: invalid fetch response');
  }

  const status = Number(response.status);

  if (!Number.isFinite(status) || status < 200 || status >= 300) {
    throw new Error(`NovelNeko: HTTP ${status}`);
  }

  const body =
    typeof response.body === 'string'
      ? response.body
      : typeof response.text === 'string'
        ? response.text
        : '';

  if (!body) {
    throw new Error('NovelNeko: empty response body');
  }

  return body;
}

function getTitleFromHTML(html) {
  const ogTitle =
    html.match(
      /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i
    ) ||
    html.match(
      /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i
    );

  if (ogTitle) return normalizeWhitespace(decodeEntities(ogTitle[1]));

  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);

  return title ? normalizeWhitespace(stripHTML(title[1])) : '';
}

function getDescriptionFromHTML(html) {
  const description =
    html.match(
      /<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i
    ) ||
    html.match(
      /<meta[^>]+content=["']([^"']*)["'][^>]+name=["']description["']/i
    );

  return description
    ? normalizeWhitespace(decodeEntities(description[1]))
    : '';
}

function getCanonicalURL(html) {
  const canonical =
    html.match(
      /<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i
    ) ||
    html.match(
      /<link[^>]+href=["']([^"']+)["'][^>]+rel=["']canonical["']/i
    );

  return canonical ? absoluteURL(canonical[1]) : null;
}

function extractLinks(html, baseURL) {
  const results = [];
  const re = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;

  let match;

  while ((match = re.exec(html))) {
    const href = absoluteURL(match[1], baseURL);

    if (!href) continue;

    const title = normalizeWhitespace(stripHTML(match[2]));

    if (!title) continue;

    results.push({
      href,
      title,
    });
  }

  return results;
}

function dedupe(items, keyFn) {
  const seen = new Set();
  const output = [];

  for (const item of items) {
    const key = keyFn(item);

    if (!key || seen.has(key)) continue;

    seen.add(key);
    output.push(item);
  }

  return output;
}

function inferNovelType(pathname) {
  if (/^\/lightnovels\//i.test(pathname)) return 'lightnovel';
  if (/^\/webnovels\//i.test(pathname)) return 'webnovel';
  if (/^\/mangas\//i.test(pathname)) return 'manga';
  return 'unknown';
}

function isNovelURL(url) {
  try {
    const parsed = new URL(url);

    return (
      parsed.hostname === 'novelneko.fr' &&
      /^\/(lightnovels|webnovels)\//i.test(parsed.pathname)
    );
  } catch {
    return false;
  }
}

function itemIDFromURL(url) {
  const parsed = new URL(assertAllowedURL(url));
  return `${parsed.pathname}${parsed.search}`;
}

function chapterIDFromURL(url) {
  const parsed = new URL(assertAllowedURL(url));

  if (!/^\/(lightnovels|webnovels)\//i.test(parsed.pathname)) {
    throw new Error('NovelNeko: invalid chapter parent URL');
  }

  return `${parsed.pathname}${parsed.search}`;
}

function parseNovelLinks(html, baseURL) {
  const links = extractLinks(html, baseURL);

  const candidates = links.filter((link) => {
    try {
      const url = new URL(link.href);

      return (
        url.hostname === 'novelneko.fr' &&
        /^\/(lightnovels|webnovels)\/[^/]+\/?$/i.test(url.pathname)
      );
    } catch {
      return false;
    }
  });

  return dedupe(candidates, (item) => item.href);
}

function parseChapterLinks(html, baseURL) {
  const links = extractLinks(html, baseURL);

  const candidates = links.filter((link) => {
    try {
      const url = new URL(link.href);

      return (
        url.hostname === 'novelneko.fr' &&
        /^\/(lightnovels|webnovels)\/[^/]+\/lecture\.html$/i.test(
          url.pathname
        ) &&
        url.searchParams.has('chapitre')
      );
    } catch {
      return false;
    }
  });

  return dedupe(candidates, (item) => item.href);
}

function parseChapterNumber(url) {
  try {
    const parsed = new URL(url);
    const value = parsed.searchParams.get('chapitre');

    if (value == null) return null;

    const number = Number(value);

    return Number.isFinite(number) ? number : null;
  } catch {
    return null;
  }
}

function parseMetadata(html) {
  const text = normalizeWhitespace(stripHTML(html));

  const metadata = {
    author: '',
    status: '',
    type: '',
    genres: [],
    description: getDescriptionFromHTML(html),
  };

  const authorMatch = text.match(
    /\bAuteur(?:e)?\s*[:\-]\s*([^\n|]+)/i
  );

  if (authorMatch) {
    metadata.author = normalizeWhitespace(authorMatch[1]);
  }

  const statusMatch = text.match(
    /\bStatut\s*[:\-]\s*([^\n|]+)/i
  );

  if (statusMatch) {
    metadata.status = normalizeWhitespace(statusMatch[1]);
  }

  const typeMatch = text.match(
    /\bType\s*[:\-]\s*([^\n|]+)/i
  );

  if (typeMatch) {
    metadata.type = normalizeWhitespace(typeMatch[1]);
  }

  const genresMatch = text.match(
    /\bGenres?\s*[:\-]\s*([^\n]+)/i
  );

  if (genresMatch) {
    metadata.genres = genresMatch[1]
      .split(/[,|]/)
      .map(normalizeWhitespace)
      .filter(Boolean);
  }

  return metadata;
}

function normalizeSearchItem(item) {
  const url = assertAllowedURL(item.href);

  return {
    id: itemIDFromURL(url),
    title: normalizeWhitespace(item.title),
    href: url,
    cover: item.cover || '',
  };
}

function extractCover(html) {
  const match =
    html.match(
      /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i
    ) ||
    html.match(
      /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i
    );

  return match ? absoluteURL(match[1]) || '' : '';
}

/*
 * NovelNeko's public URL structure observed during inspection:
 *
 *   /lightnovels/<slug>/
 *   /webnovels/<slug>/
 *   /lightnovels/<slug>/lecture.html?chapitre=<n>
 *   /webnovels/<slug>/lecture.html?chapitre=<n>
 *
 * Search endpoint details were not exposed reliably by the public crawler.
 * The module therefore uses the source homepage as the search/discovery
 * surface instead of fabricating an API endpoint.
 *
 * A browser/site implementation may expose a richer search form at runtime;
 * this implementation intentionally refuses to guess it.
 */

async function discoveryHome() {
  const html = await fetchHTML(BASE_URL);

  if (isBlockedPage(html)) {
    throw new Error('NovelNeko: blocked/challenge page');
  }

  const novels = parseNovelLinks(html, BASE_URL);

  return {
    sections: [
      {
        id: 'latest',
        title: 'Dernières sorties',
        kind: 'latest',
      },
      {
        id: 'lightnovels',
        title: 'Light-Novels',
        kind: 'category',
      },
      {
        id: 'webnovels',
        title: 'Web-Novels',
        kind: 'category',
      },
    ],
    items: novels
      .slice(0, MAX_RESULTS)
      .map(normalizeSearchItem),
    page: 1,
    hasMore: novels.length > MAX_RESULTS,
  };
}

async function discoveryFeed(feedID, page = 1) {
  const normalizedPage = Math.max(
    1,
    Math.min(MAX_PAGE, Number(page) || 1)
  );

  if (!['latest', 'lightnovels', 'webnovels'].includes(feedID)) {
    throw new Error(`NovelNeko: unsupported feed ${feedID}`);
  }

  /*
   * No unobserved pagination endpoint is fabricated here.
   * Fetching the public homepage remains deterministic and safe.
   */
  const html = await fetchHTML(BASE_URL);

  if (isBlockedPage(html)) {
    throw new Error('NovelNeko: blocked/challenge page');
  }

  let items = parseNovelLinks(html, BASE_URL);

  if (feedID === 'lightnovels') {
    items = items.filter((item) => inferNovelType(new URL(item.href).pathname) === 'lightnovel');
  }

  if (feedID === 'webnovels') {
    items = items.filter((item) => inferNovelType(new URL(item.href).pathname) === 'webnovel');
  }

  const start = (normalizedPage - 1) * MAX_RESULTS;
  const pageItems = items.slice(start, start + MAX_RESULTS);

  return {
    section: {
      id: feedID,
      title:
        feedID === 'latest'
          ? 'Dernières sorties'
          : feedID === 'lightnovels'
            ? 'Light-Novels'
            : 'Web-Novels',
    },
    items: pageItems.map(normalizeSearchItem),
    page: normalizedPage,
    hasMore: start + MAX_RESULTS < items.length,
  };
}

async function searchResults(query, page = 1) {
  const cleanQuery = normalizeWhitespace(query);

  if (!cleanQuery) {
    return {
      items: [],
      page: 1,
      hasMore: false,
      query: '',
    };
  }

  /*
   * Important:
   * The exact NovelNeko search request URL was not observable reliably.
   * Do not invent "?s=", "/search", or an undocumented API.
   *
   * We therefore perform a bounded search over the public homepage links.
   * This is intentionally conservative and may return fewer results than
   * NovelNeko's own search.
   */
  const html = await fetchHTML(BASE_URL);

  if (isBlockedPage(html)) {
    throw new Error('NovelNeko: blocked/challenge page');
  }

  const terms = cleanQuery
    .toLocaleLowerCase('fr-FR')
    .split(/\s+/)
    .filter(Boolean);

  const items = parseNovelLinks(html, BASE_URL)
    .map(normalizeSearchItem)
    .filter((item) => {
      const haystack = item.title.toLocaleLowerCase('fr-FR');

      return terms.every((term) => haystack.includes(term));
    });

  const normalizedPage = Math.max(
    1,
    Math.min(MAX_PAGE, Number(page) || 1)
  );

  const start = (normalizedPage - 1) * MAX_RESULTS;

  return {
    items: items.slice(start, start + MAX_RESULTS),
    page: normalizedPage,
    hasMore: start + MAX_RESULTS < items.length,
    query: cleanQuery,
  };
}

async function extractDetails(itemID) {
  const url = assertAllowedURL(
    itemID.startsWith('http')
      ? itemID
      : new URL(itemID, BASE_URL).href
  );

  if (!isNovelURL(url)) {
    throw new Error('NovelNeko: item is not a supported novel URL');
  }

  const html = await fetchHTML(url);

  if (isBlockedPage(html)) {
    throw new Error('NovelNeko: blocked/challenge/error page');
  }

  const metadata = parseMetadata(html);
  const title = getTitleFromHTML(html);
  const cover = extractCover(html);

  if (!title) {
    throw new Error('NovelNeko: source title not found');
  }

  return {
    id: itemIDFromURL(url),
    title: title.replace(/\s*[-|]\s*NovelNeko\s*$/i, '').trim(),
    href: url,
    cover,
    description: metadata.description,
    author: metadata.author,
    status: metadata.status,
    tags: metadata.genres,
    type: metadata.type || inferNovelType(new URL(url).pathname),
  };
}

async function extractChapters(itemID) {
  const url = assertAllowedURL(
    itemID.startsWith('http')
      ? itemID
      : new URL(itemID, BASE_URL).href
  );

  if (!isNovelURL(url)) {
    throw new Error('NovelNeko: invalid novel URL');
  }

  const html = await fetchHTML(url);

  if (isBlockedPage(html)) {
    throw new Error('NovelNeko: blocked/challenge/error page');
  }

  const links = parseChapterLinks(html, url);

  const chapters = links
    .map((link) => ({
      id: chapterIDFromURL(link.href),
      title: normalizeWhitespace(link.title),
      href: link.href,
      number: parseChapterNumber(link.href),
    }))
    .sort((a, b) => {
      const an = a.number;
      const bn = b.number;

      if (an == null && bn == null) {
        return a.title.localeCompare(b.title, 'fr');
      }

      if (an == null) return 1;
      if (bn == null) return -1;

      return an - bn;
    });

  return {
    itemID: itemIDFromURL(url),
    chapters: dedupe(chapters, (chapter) => chapter.id),
  };
}

function extractReaderText(html) {
  /*
   * Only accept actual text containers from the response.
   * We deliberately do not derive or guess the site's hidden .txt path.
   */

  const candidates = [];

  const preMatches = html.match(
    /<pre\b[^>]*>([\s\S]*?)<\/pre>/gi
  ) || [];

  for (const block of preMatches) {
    candidates.push(stripHTML(block));
  }

  const articleMatches = html.match(
    /<article\b[^>]*>([\s\S]*?)<\/article>/gi
  ) || [];

  for (const block of articleMatches) {
    candidates.push(stripHTML(block));
  }

  const contentMatches = html.match(
    /<(?:main|section|div)\b[^>]*(?:id|class)=["'][^"']*(?:chapter|lecture|reader|content|texte)[^"']*["'][^>]*>([\s\S]*?)<\/(?:main|section|div)>/gi
  ) || [];

  for (const block of contentMatches) {
    candidates.push(stripHTML(block));
  }

  const cleaned = candidates
    .map(normalizeWhitespace)
    .filter((value) => value.length >= 100)
    .sort((a, b) => b.length - a.length);

  return cleaned[0] || '';
}

async function extractText(sectionID) {
  let url;

  try {
    url = assertAllowedURL(
      sectionID.startsWith('http')
        ? sectionID
        : new URL(sectionID, BASE_URL).href
    );
  } catch {
    throw new Error('NovelNeko: invalid section URL');
  }

  const parsed = new URL(url);

  if (
    !/^\/(lightnovels|webnovels)\/[^/]+\/lecture\.html$/i.test(
      parsed.pathname
    ) ||
    !parsed.searchParams.has('chapitre')
  ) {
    throw new Error('NovelNeko: unsupported section URL');
  }

  const html = await fetchHTML(url, {
    maxBytesHint: MAX_TEXT_BYTES,
  });

  if (isBlockedPage(html)) {
    throw new Error('NovelNeko: blocked/challenge/error reader page');
  }

  const text = extractReaderText(html);

  if (!text) {
    throw new Error(
      'NovelNeko: terminal chapter text is not present in the fetched HTML'
    );
  }

  return {
    sectionID: chapterIDFromURL(url),
    contentType: 'text',
    text,
  };
}

const handlers = {
  discoveryHome,
  discoveryFeed,
  searchResults,
  extractDetails,
  extractChapters,
  extractText,
};

const globalObject = getGlobal();

globalObject.SynthetiqModule = handlers;
Object.assign(globalObject, handlers);