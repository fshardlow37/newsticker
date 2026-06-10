const { app, BrowserWindow, ipcMain, shell, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');

// Disable GPU process — text-only widget doesn't need hardware acceleration
app.disableHardwareAcceleration();

// ── Window State Persistence ──────────────────────────────────────────

const stateFile = path.join(app.getPath('userData'), 'window-state.json');

function loadWindowState() {
  try {
    return JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  } catch {
    return { width: 300, height: 400 };
  }
}

function saveWindowState(bounds) {
  try {
    fs.writeFileSync(stateFile, JSON.stringify(bounds));
  } catch (e) {
    console.error('Failed to save window state:', e);
  }
}

function isPositionOnScreen(x, y) {
  const displays = screen.getAllDisplays();
  return displays.some(d => {
    const b = d.bounds;
    return x >= b.x && x < b.x + b.width && y >= b.y && y < b.y + b.height;
  });
}

// ── HTTP Helpers ──────────────────────────────────────────────────────

const MAX_RESPONSE_SIZE = 5 * 1024 * 1024; // 5 MB

function fetchUrl(url, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, { timeout: 10000, headers: { 'User-Agent': 'NewsTicker/2.0' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume(); // drain so the socket is released
        if (maxRedirects <= 0) { reject(new Error('Too many redirects')); return; }
        const loc = res.headers.location;
        if (!loc.startsWith('http://') && !loc.startsWith('https://')) {
          reject(new Error('Redirect to non-HTTP URL blocked')); return;
        }
        fetchUrl(loc, maxRedirects - 1).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}`));
        res.resume();
        return;
      }
      let data = '';
      res.on('data', chunk => {
        data += chunk;
        if (data.length > MAX_RESPONSE_SIZE) {
          res.destroy();
          reject(new Error('Response too large'));
        }
      });
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

function fetchJSON(url) {
  return fetchUrl(url).then(data => JSON.parse(data));
}

function postJSON(url, body) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const payload = JSON.stringify(body);
    const opts = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      timeout: 120000,
    };
    const client = parsed.protocol === 'https:' ? https : http;
    const req = client.request(opts, (res) => {
      let data = '';
      res.on('data', chunk => {
        data += chunk;
        if (data.length > MAX_RESPONSE_SIZE) {
          res.destroy();
          reject(new Error('Response too large'));
        }
      });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error('Invalid JSON response')); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    req.write(payload);
    req.end();
  });
}

// ── Environment Loading ───────────────────────────────────────────────

function loadEnvFile() {
  const locations = [
    path.join(__dirname, '.env'),
    path.join(app.getPath('userData'), '.env'),
  ];
  for (const loc of locations) {
    try {
      const content = fs.readFileSync(loc, 'utf8');
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx === -1) continue;
        const key = trimmed.slice(0, eqIdx).trim();
        const value = trimmed.slice(eqIdx + 1).trim().replace(/^['"]|['"]$/g, '');
        if (!process.env[key]) process.env[key] = value;
      }
      console.log(`Loaded .env from ${loc}`);
      return;
    } catch {}
  }
  console.warn('No .env file found. API keys must be set as environment variables.');
}

loadEnvFile();

const API_KEYS = {
  newsapi: process.env.NEWSAPI_KEY || '',
  gnews: process.env.GNEWS_KEY || '',
  guardian: process.env.GUARDIAN_KEY || '',
  nytimes: process.env.NYTIMES_KEY || '',
  currents: process.env.CURRENTS_KEY || '',
};

// ── RSS Feed Sources ──────────────────────────────────────────────────

const RSS_FEEDS = [
  'https://feeds.bbci.co.uk/news/world/rss.xml',
  'https://feeds.bbci.co.uk/news/rss.xml',
  'https://www.theguardian.com/world/rss',
  'https://rss.nytimes.com/services/xml/rss/nyt/World.xml',
  'https://www.aljazeera.com/xml/rss/all.xml',
  'https://feeds.arstechnica.com/arstechnica/index',
  'https://www.wired.com/feed/rss',
  'https://feeds.bbci.co.uk/news/science_and_environment/rss.xml',
  'https://feeds.bbci.co.uk/news/technology/rss.xml',
  'https://www.theverge.com/rss/index.xml',
  'https://feeds.bbci.co.uk/news/business/rss.xml',
  'https://www.theguardian.com/business/rss',
  'https://www.theargus.co.uk/news/rss/',
  'https://www.theguardian.com/sport/rss',
  // Hantavirus-focused feeds
  'https://news.google.com/rss/search?q=hantavirus&hl=en&gl=US&ceid=US:en',
  'https://news.google.com/rss/search?q=hantavirus+outbreak&hl=en&gl=US&ceid=US:en',
];

// ── AI Feed Sources ───────────────────────────────────────────────────
// Dedicated "what is AI actually doing" slots: capabilities, agents,
// AI making discoveries / finding bugs / shipping, not think-pieces.

const AI_RSS_FEEDS = [
  'https://news.google.com/rss/search?q=%22AI%20agent%22%20OR%20%22AI%20model%22&hl=en&gl=US&ceid=US:en',
  'https://news.google.com/rss/search?q=%22AI%20discovers%22%20OR%20%22AI%20finds%22%20OR%20%22AI%20solves%22%20OR%20%22AI%20detects%22&hl=en&gl=US&ceid=US:en',
  'https://news.google.com/rss/search?q=Anthropic%20OR%20OpenAI%20OR%20%22Google%20DeepMind%22%20OR%20Claude%20OR%20Gemini&hl=en&gl=US&ceid=US:en',
  'https://news.google.com/rss/search?q=%22artificial%20intelligence%22%20breakthrough%20OR%20release%20OR%20launch&hl=en&gl=US&ceid=US:en',
];

// ── RSS Parsing ───────────────────────────────────────────────────────

function parseRSS(xml, feedUrl) {
  const items = [];
  const source = feedUrl.match(/\/\/(?:www\.|feeds\.)?([^./]+)/)?.[1] || 'unknown';
  const itemRegex = /<(?:item|entry)[\s>]([\s\S]*?)<\/(?:item|entry)>/gi;
  let match;
  while ((match = itemRegex.exec(xml)) !== null) {
    const block = match[1];
    const title = extractTag(block, 'title');
    const link = extractLink(block);
    const description = extractTag(block, 'description') || extractTag(block, 'summary') || '';
    const pubDate = extractTag(block, 'pubDate') || extractTag(block, 'published') || extractTag(block, 'updated') || '';
    if (title && link) {
      items.push({
        title: cleanHtml(title),
        url: link,
        description: cleanHtml(description),
        source,
        publishedAt: pubDate,
      });
    }
  }
  return items;
}

function extractTag(block, tag) {
  const regex = new RegExp(`<${tag}[^>]*>\\s*(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?\\s*</${tag}>`, 'i');
  const m = block.match(regex);
  return m ? m[1].trim() : null;
}

function extractLink(block) {
  const linkTag = block.match(/<link[^>]*>([^<]+)<\/link>/i);
  if (linkTag) return linkTag[1].trim();
  const atomLink = block.match(/<link[^>]*href=["']([^"']+)["']/i);
  if (atomLink) return atomLink[1].trim();
  return null;
}

function cleanHtml(text) {
  return text.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'").trim();
}

// Strip the trailing " - Publisher" / " | Publisher" that Google News appends.
function cleanTitle(text) {
  return (text || '').replace(/\s+[-|–—]\s+[^-|–—]{2,40}$/, '').trim();
}

// Tolerant JSON-array extraction — the 3B sometimes truncates before the
// closing bracket. Try a clean parse first, then repair a cut-off array.
function parseJsonArrayLoose(text) {
  const start = text.indexOf('[');
  if (start === -1) return null;
  const greedy = text.slice(start).match(/\[[\s\S]*\]/);
  if (greedy) {
    try { return JSON.parse(greedy[0]); } catch {}
  }
  const lastBrace = text.lastIndexOf('}');
  if (lastBrace > start) {
    try { return JSON.parse(text.slice(start, lastBrace + 1) + ']'); } catch {}
  }
  return null;
}

// ── API Fetchers ──────────────────────────────────────────────────────
// Each returns normalized {title, url, description, source, publishedAt}[]

async function fetchRSSFeeds() {
  const results = await Promise.allSettled(
    RSS_FEEDS.map(async (feedUrl) => {
      const xml = await fetchUrl(feedUrl);
      return parseRSS(xml, feedUrl);
    })
  );
  return results.filter(r => r.status === 'fulfilled').flatMap(r => r.value);
}

async function fetchAIFeeds() {
  const results = await Promise.allSettled(
    AI_RSS_FEEDS.map(async (feedUrl) => {
      const xml = await fetchUrl(feedUrl);
      return parseRSS(xml, feedUrl);
    })
  );
  return results.filter(r => r.status === 'fulfilled').flatMap(r => r.value);
}

async function fetchNewsAPI() {
  if (!API_KEYS.newsapi) return [];
  try {
    const data = await fetchJSON(`https://newsapi.org/v2/top-headlines?country=us&pageSize=50&apiKey=${API_KEYS.newsapi}`);
    return (data.articles || []).map(a => ({
      title: a.title || '',
      url: a.url || '',
      description: a.description || '',
      source: a.source?.name || 'NewsAPI',
      publishedAt: a.publishedAt || '',
    }));
  } catch (e) {
    console.warn('NewsAPI failed:', e.message);
    return [];
  }
}

async function fetchGNews() {
  if (!API_KEYS.gnews) return [];
  try {
    const data = await fetchJSON(`https://gnews.io/api/v4/top-headlines?lang=en&max=50&apikey=${API_KEYS.gnews}`);
    return (data.articles || []).map(a => ({
      title: a.title || '',
      url: a.url || '',
      description: a.description || '',
      source: a.source?.name || 'GNews',
      publishedAt: a.publishedAt || '',
    }));
  } catch (e) {
    console.warn('GNews failed:', e.message);
    return [];
  }
}

async function fetchGuardian() {
  if (!API_KEYS.guardian) return [];
  try {
    const data = await fetchJSON(`https://content.guardianapis.com/search?order-by=newest&page-size=50&show-fields=trailText&api-key=${API_KEYS.guardian}`);
    return (data.response?.results || []).map(a => ({
      title: a.webTitle || '',
      url: a.webUrl || '',
      description: a.fields?.trailText || '',
      source: 'The Guardian',
      publishedAt: a.webPublicationDate || '',
    }));
  } catch (e) {
    console.warn('Guardian API failed:', e.message);
    return [];
  }
}

async function fetchNYT() {
  if (!API_KEYS.nytimes) return [];
  try {
    const data = await fetchJSON(`https://api.nytimes.com/svc/topstories/v2/home.json?api-key=${API_KEYS.nytimes}`);
    return (data.results || []).map(a => ({
      title: a.title || '',
      url: a.url || '',
      description: a.abstract || '',
      source: 'New York Times',
      publishedAt: a.published_date || '',
    }));
  } catch (e) {
    console.warn('NYT API failed:', e.message);
    return [];
  }
}

async function fetchCurrents() {
  if (!API_KEYS.currents) return [];
  try {
    const data = await fetchJSON(`https://api.currentsapi.services/v1/latest-news?language=en&apiKey=${API_KEYS.currents}`);
    return (data.news || []).map(a => ({
      title: a.title || '',
      url: a.url || '',
      description: a.description || '',
      source: a.author || 'Currents',
      publishedAt: a.published || '',
    }));
  } catch (e) {
    console.warn('Currents API failed:', e.message);
    return [];
  }
}

// ── Ollama Lifecycle ─────────────────────────────────────────────────

const { spawn } = require('child_process');

let ollamaProcess = null;
let ollamaExited = false;

function isOllamaRunning() {
  return fetchUrl('http://localhost:11434/').then(() => true).catch(() => false);
}

async function ensureOllama() {
  if (await isOllamaRunning()) return;

  // Only spawn if we haven't already, or if the previous spawn died
  if (!ollamaProcess || ollamaExited) {
    console.log('Starting ollama serve...');
    sendStatus('Starting Ollama...');

    ollamaExited = false;
    const child = spawn('ollama', ['serve'], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.on('exit', (code) => {
      console.log(`ollama serve exited (code ${code})`);
      ollamaExited = true;
    });
    child.on('error', (err) => {
      console.error('ollama serve error:', err.message);
      ollamaExited = true;
    });
    child.unref();
    ollamaProcess = child;
  } else {
    console.log('Ollama process still starting, waiting...');
    sendStatus('Waiting for Ollama...');
  }

  // Wait up to 15s for the server to be ready
  for (let i = 0; i < 30; i++) {
    if (ollamaExited) {
      ollamaProcess = null;
      throw new Error('ollama serve exited unexpectedly');
    }
    await new Promise(r => setTimeout(r, 500));
    if (await isOllamaRunning()) {
      console.log('Ollama ready');
      return;
    }
  }
  // Process is still alive but not responding yet — don't kill it, just skip this cycle
  throw new Error('Ollama not ready yet (process still starting)');
}

// ── URL Validation ───────────────────────────────────────────────────

function isSafeUrl(url) {
  try { return ['http:', 'https:'].includes(new URL(url).protocol); }
  catch { return false; }
}

// ── Ollama Integration ────────────────────────────────────────────────

function filterLast24Hours(articles) {
  const cutoff = Date.now() - (24 * 60 * 60 * 1000);
  return articles.filter(a => {
    if (!a.publishedAt) return true; // keep if no date (benefit of doubt)
    const parsed = new Date(a.publishedAt).getTime();
    if (isNaN(parsed)) return true; // keep if unparseable
    return parsed >= cutoff;
  });
}

// ── Spam / Promo Filter ──────────────────────────────────────────────

const PROMO_PATTERNS = [
  /\bpromo(?:tion(?:al)?|s)?\s*code/i,
  /\bcoupon/i,
  /\bdiscount\s*code/i,
  /\bdeal(?:s)?\s*(?:of|for|on|this|today|you)/i,
  /\bbest\s+(?:deals|buys|prices)/i,
  /\bsale\s*(?:alert|event|now|today|ends)/i,
  /\bvoucher/i,
  /\baffiliate/i,
  /\bsponsored\b/i,
  /\bad\b.*\b(?:partner|feature)/i,
  /\bshop\s+(?:now|these|the\s+best)/i,
  /\bbuy\s+(?:now|one|this)/i,
  /\bsave\s+\d+%/i,
  /\b(?:cheapest|lowest\s+price)/i,
  /\bfree\s+(?:trial|shipping|delivery)/i,
  /\bsubscri(?:be|ption)\s+(?:deal|offer|discount|box)/i,
  /\blimited[\s-]+time\s+offer/i,
  /\bexclusive\s+(?:deal|offer|discount|savings)/i,
  /\b(?:black\s+friday|cyber\s+monday|prime\s+day)\s+deal/i,
  /\bgift\s+(?:guide|ideas?\s+for)/i,
  /\bunder\s+\$\d+/i,
  /\b(?:where|how)\s+to\s+buy\b/i,
  /\breview(?:ed)?:\s/i,
  /\bvs\.?\s/i,
  /\bbest\s+\w+\s+(?:for|in|of)\s+\d{4}/i,
];

// ── Opinion / Editorial Filter ───────────────────────────────────────

// Title-only patterns — only clear opinion/editorial markers
const OPINION_PATTERNS = [
  /\bopinion[\s:|-]/i,
  /\beditorial[\s:|-]/i,
  /\bcommentary[\s:|-]/i,
  /\bop[\s-]ed\b/i,
  /\bcolumn[\s:|-]/i,
  /\bletter(?:s)?\s+to\s+the\s+editor/i,
  /\bthe\s+case\s+(?:for|against)\b/i,
  /\bwill\s+test\s+(?:if|whether)\b/i,
  /\blearned\s+(?:anything|nothing)\b/i,
];

function isOpinionContent(article) {
  return OPINION_PATTERNS.some(rx => rx.test(article.title));
}

function isPromoContent(article) {
  const text = (article.title + ' ' + (article.description || '')).toLowerCase();
  return PROMO_PATTERNS.some(rx => rx.test(text));
}

// ── Priority Topics ──────────────────────────────────────────────────

const PRIORITY_TOPICS = [
  /\bhantavirus\b/i,
  /\bhanta\b/i,
];

function isPriorityTopic(article) {
  const text = (article.title + ' ' + (article.description || ''));
  return PRIORITY_TOPICS.some(rx => rx.test(text));
}

function preFilterArticles(articles) {
  // Remove promotional and opinion/editorial content
  const clean = articles.filter(a => !isPromoContent(a) && !isOpinionContent(a));
  const promoRemoved = articles.filter(a => isPromoContent(a)).length;
  const opinionRemoved = articles.filter(a => !isPromoContent(a) && isOpinionContent(a)).length;
  if (promoRemoved > 0) console.log(`Promo filter removed ${promoRemoved} article(s)`);
  if (opinionRemoved > 0) console.log(`Opinion filter removed ${opinionRemoved} article(s)`);

  // Deduplicate by normalized first 6 words (keeps one per story angle)
  const seen = new Set();
  const unique = clean.filter(a => {
    const key = a.title.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).slice(0, 6).join(' ');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Score each article: coverage (how many sources) + recency boost
  const now = Date.now();
  const wordSets = unique.map(a =>
    new Set(a.title.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(w => w.length > 3))
  );

  const scored = unique.map((a, i) => {
    // Coverage: how many other articles share 3+ significant words
    let coverage = 0;
    for (let j = 0; j < wordSets.length; j++) {
      if (i === j) continue;
      const overlap = [...wordSets[i]].filter(w => wordSets[j].has(w)).length;
      if (overlap >= 3) coverage++;
    }
    // Recency: 0-1 scale, 1.0 = just published, 0.0 = 24h old
    const ts = a.publishedAt ? new Date(a.publishedAt).getTime() : 0;
    const age = ts > 0 ? Math.max(0, now - ts) : 12 * 60 * 60 * 1000; // default 12h if unknown
    const recency = Math.max(0, 1 - age / (24 * 60 * 60 * 1000));
    // Combined: coverage matters, but recency breaks ties and boosts fresh stories
    const score = coverage + recency * 2;
    return { article: a, score, coverage, recency };
  });

  // Sort by combined score, cap priority-topic at 5
  scored.sort((a, b) => b.score - a.score);
  const MAX_PRIORITY = 5;
  const top = [];
  let priorityCount = 0;
  for (const s of scored) {
    if (top.length >= 20) break;
    if (isPriorityTopic(s.article)) {
      if (priorityCount >= MAX_PRIORITY) continue;
      priorityCount++;
    }
    top.push(s.article);
  }

  // Ensure at least 3 priority-topic articles are included
  if (priorityCount < 3) {
    const missing = unique
      .filter(a => isPriorityTopic(a) && !top.includes(a))
      .slice(0, 3 - priorityCount);
    if (missing.length > 0) {
      console.log(`Injecting ${missing.length} priority-topic article(s) into candidates`);
      top.push(...missing);
      priorityCount += missing.length;
    }
  }

  // Sort final candidates by recency so Ollama sees freshest first
  top.sort((a, b) => {
    const tsA = a.publishedAt ? new Date(a.publishedAt).getTime() : 0;
    const tsB = b.publishedAt ? new Date(b.publishedAt).getTime() : 0;
    return tsB - tsA;
  });

  console.log(`Candidate pool: ${top.length} articles (${priorityCount} priority-topic)`);
  return top;
}

// Stop words excluded from semantic comparison
const STOP_WORDS = new Set([
  'the','a','an','in','on','at','to','for','of','and','or','is','are','was',
  'were','be','been','has','have','had','with','from','by','as','its','it',
  'that','this','but','not','new','says','said','after','over','into','more',
]);

function headlineWords(text) {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/)
    .filter(w => w.length > 1 && !STOP_WORDS.has(w));
}

function findBestMatch(text, articles) {
  const words = new Set(headlineWords(text));
  const scored = articles.map(a => {
    const overlap = headlineWords(a.title).filter(w => words.has(w)).length;
    const ts = a.publishedAt ? new Date(a.publishedAt).getTime() : 0;
    return { article: a, overlap, ts };
  });
  // Sort by overlap (desc), then recency (desc) to break ties
  scored.sort((a, b) => b.overlap - a.overlap || b.ts - a.ts);
  return scored[0]?.article || articles[0];
}

function timeAgo(date) {
  const mins = Math.floor((Date.now() - date.getTime()) / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ago`;
}

async function queryOllama(filtered, totalCount, count = 7) {
  console.log(`Sending ${filtered.length} articles (from ${totalCount}) to Ollama`);

  const headlineList = filtered.map((a, i) => {
    const age = a.publishedAt ? timeAgo(new Date(a.publishedAt)) : '';
    const desc = a.description ? ` — ${a.description.slice(0, 80)}` : '';
    return `${i + 1}. [${a.source}]${age ? ' (' + age + ')' : ''} ${a.title}${desc}`;
  }).join('\n');

  const hantaSlots = Math.min(2, count - 1);
  const prompt = `Below are ${filtered.length} real news headlines from the last 24 hours, with age shown in parentheses. Prefer the most RECENT developments — a story from 1h ago beats a similar story from 12h ago. Select the ${count} most globally significant DISTINCT events. Each must be a DIFFERENT story — no two items about the same event. Only stories affecting millions of people, major geopolitical shifts, or major scientific advances. No opinion, no individual crime, no entertainment, no celebrity, no niche policy, no promotions, no deals, no product reviews, no ads.

PRIORITY: If hantavirus-related headlines appear below, include up to ${hantaSlots} of the most significant and RECENT hantavirus developments (each a DIFFERENT story). The remaining slots must be other global news.

For each, write a neutral 7-10 word headline and a 15-20 word description. The description MUST add new information not in the headline — context, numbers, who, where, or consequences. Never repeat or rephrase the headline.

sourceIndex = the number of the headline from the list below.
Categories: global, science, interests, future, general
breaking=true if very recent, updated=true if ongoing story with new info.

STRICT DEDUP: Two headlines about the same event (even from different angles, cities, or phases) count as ONE event. E.g. "journalist kidnapped in Baghdad" and "journalist kidnapped in Iraq" are the SAME story — only include it once. When in doubt, treat as duplicate.

Output ONLY valid JSON array, no other text. Exactly ${count} items, each a DIFFERENT event.
[{"headline":"...","description":"...","category":"global","breaking":false,"updated":false,"sourceIndex":1}]

${headlineList}`;

  console.log(`Ollama prompt size: ${prompt.length} chars, ${filtered.length} headlines`);

  try {
    await ensureOllama();

    const response = await postJSON('http://localhost:11434/api/generate', {
      model: 'llama3.2:3b',
      prompt,
      stream: false,
      keep_alive: 0,  // unload model from memory immediately after response
      options: {
        temperature: 0.3,
        num_predict: 2048,
      },
    });

    const text = response.response || '';
    console.log('Ollama raw response:', text.slice(0, 500));

    const items = parseJsonArrayLoose(text);
    if (!items) throw new Error('No JSON array in Ollama response: ' + text.slice(0, 200));
    console.log('Ollama item[0]:', JSON.stringify(items[0]).slice(0, 300));
    const mapped = items.slice(0, count).map(item => {
      // Small models drift on key names — find the first non-empty string for headline/description
      const hl = item.headline || item.title || item.name || item.heading ||
        Object.values(item).find(v => typeof v === 'string' && v.length > 10 && v.length < 80) ||
        'Untitled';
      const desc = item.description || item.summary || item.desc || item.detail || item.details || item.text || '';
      // Match back to source article by content similarity (sourceIndex is unreliable)
      const srcArticle = findBestMatch(hl + ' ' + desc, filtered);
      return {
        headline: hl,
        description: desc,
        category: item.category || item.cat || item.type || 'general',
        breaking: !!item.breaking,
        updated: !!item.updated,
        url: srcArticle?.url || '',
      };
    });
    return deduplicateHeadlines(mapped);
  } catch (e) {
    console.error('Ollama failed:', e.message, e.stack);
    return null; // signal fallback needed
  }
}

function semanticSimilarity(a, b) {
  const wordsA = headlineWords(a);
  const wordsB = new Set(headlineWords(b));
  if (wordsA.length === 0 || wordsB.size === 0) return 0;
  const overlap = wordsA.filter(w => wordsB.has(w)).length;
  return overlap / Math.min(wordsA.length, wordsB.size);
}

function deduplicateHeadlines(headlines) {
  const kept = [];
  for (const h of headlines) {
    const isDup = kept.some(k => semanticSimilarity(k.headline, h.headline) >= 0.6);
    if (!isDup) kept.push(h);
  }
  if (kept.length < headlines.length) {
    console.log(`Dedup removed ${headlines.length - kept.length} duplicate headline(s)`);
  }
  return kept;
}

// ── AI Slot Selection ─────────────────────────────────────────────────
// Two dedicated slots for "what AI is actually doing" — capabilities,
// agents, models shipping, AI making discoveries or finding bugs.

const AI_SLOT_COUNT = 2;

const AI_KEYWORDS = [
  /\bAI\b/, /\bA\.I\.\b/i, /\bartificial intelligence\b/i, /\bmachine learning\b/i,
  /\bLLM\b/i, /\blarge language model\b/i, /\bneural network\b/i, /\bgenerative\b/i,
  /\bchatbot\b/i, /\bAI agent\b/i, /\bagentic\b/i,
  /\bOpenAI\b/i, /\bAnthropic\b/i, /\bDeepMind\b/i, /\bClaude\b/i, /\bChatGPT\b/i,
  /\bGPT-?\d/i, /\bGemini\b/i, /\bLlama\b/i, /\bMistral\b/i, /\bCopilot\b/i, /\bGrok\b/i,
];

function isAIContent(article) {
  const text = (article.title + ' ' + (article.description || ''));
  return AI_KEYWORDS.some(rx => rx.test(text));
}

// Light pre-filter for AI candidates: relevance, dedup, recency+coverage rank.
function preFilterAIArticles(articles) {
  const clean = articles.filter(a =>
    isAIContent(a) && !isPromoContent(a) && !isOpinionContent(a)
  );

  const seen = new Set();
  const unique = clean.filter(a => {
    const key = a.title.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).slice(0, 6).join(' ');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const now = Date.now();
  const wordSets = unique.map(a =>
    new Set(a.title.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(w => w.length > 3))
  );
  const scored = unique.map((a, i) => {
    let coverage = 0;
    for (let j = 0; j < wordSets.length; j++) {
      if (i === j) continue;
      const overlap = [...wordSets[i]].filter(w => wordSets[j].has(w)).length;
      if (overlap >= 3) coverage++;
    }
    const ts = a.publishedAt ? new Date(a.publishedAt).getTime() : 0;
    const age = ts > 0 ? Math.max(0, now - ts) : 12 * 60 * 60 * 1000;
    const recency = Math.max(0, 1 - age / (24 * 60 * 60 * 1000));
    return { article: a, score: coverage + recency * 2 };
  });
  scored.sort((a, b) => b.score - a.score);

  const top = scored.slice(0, 12).map(s => s.article);
  top.sort((a, b) => {
    const tsA = a.publishedAt ? new Date(a.publishedAt).getTime() : 0;
    const tsB = b.publishedAt ? new Date(b.publishedAt).getTime() : 0;
    return tsB - tsA;
  });
  console.log(`AI candidate pool: ${top.length} articles`);
  return top;
}

async function queryOllamaAI(filtered) {
  if (filtered.length === 0) return [];
  console.log(`Sending ${filtered.length} AI articles to Ollama`);

  const headlineList = filtered.map((a, i) => {
    const age = a.publishedAt ? timeAgo(new Date(a.publishedAt)) : '';
    const desc = a.description ? ` — ${a.description.slice(0, 80)}` : '';
    return `${i + 1}. [${a.source}]${age ? ' (' + age + ')' : ''} ${a.title}${desc}`;
  }).join('\n');

  const prompt = `Below are ${filtered.length} real AI-related news headlines from the last 24 hours, with age shown in parentheses. Select the ${AI_SLOT_COUNT} most significant developments about WHAT AI SYSTEMS ARE ACTUALLY DOING — new models or agents shipping, AI finding bugs, AI making scientific discoveries, real capability advances or deployments. Prefer the most RECENT. Each must be a DIFFERENT story. Avoid opinion, hype, stock-price moves, funding rumors, regulation debates, and "AI might/could" speculation — focus on concrete things AI did or that were released.

For each, write a neutral 7-10 word headline and a 15-20 word description. The description MUST add new information not in the headline — context, numbers, who, or consequences. Never repeat or rephrase the headline.

sourceIndex = the number of the headline from the list below.
breaking=true if very recent, updated=true if ongoing story with new info.

Output ONLY valid JSON array, no other text. Exactly ${AI_SLOT_COUNT} items, each a DIFFERENT event.
[{"headline":"...","description":"...","breaking":false,"updated":false,"sourceIndex":1}]

${headlineList}`;

  try {
    await ensureOllama();
    const response = await postJSON('http://localhost:11434/api/generate', {
      model: 'llama3.2:3b',
      prompt,
      stream: false,
      keep_alive: 0,
      options: { temperature: 0.3, num_predict: 1024 },
    });

    const text = response.response || '';
    console.log('Ollama AI raw response:', text.slice(0, 300));
    const items = parseJsonArrayLoose(text);
    if (!items) throw new Error('No JSON array in Ollama AI response');

    const mapped = items.slice(0, AI_SLOT_COUNT).map(item => {
      let hl = item.headline || item.title || item.name || item.heading ||
        Object.values(item).find(v => typeof v === 'string' && v.length > 10 && v.length < 100) || '';
      let desc = item.description || item.summary || item.desc || item.detail || item.details || item.text || '';

      // The 3B often returns ONLY a sourceIndex with no text. Resolve the source
      // article by content when we have it, else by the index the model gave.
      const idx = parseInt(item.sourceIndex ?? item.index ?? item.id, 10);
      const byIndex = (idx >= 1 && idx <= filtered.length) ? filtered[idx - 1] : null;
      const srcArticle = (hl || desc) ? findBestMatch(hl + ' ' + desc, filtered) : (byIndex || filtered[0]);

      // Recover a real headline/description from the article if the model dropped them.
      if (!hl) hl = cleanTitle((byIndex || srcArticle)?.title) || 'AI update';
      if (!desc) desc = ((byIndex || srcArticle)?.description || '').slice(0, 120);

      return {
        headline: hl,
        description: desc,
        category: 'ai',
        breaking: !!item.breaking,
        updated: !!item.updated,
        url: srcArticle?.url || '',
      };
    });
    return padAISlots(deduplicateHeadlines(mapped), filtered);
  } catch (e) {
    console.error('Ollama AI query failed:', e.message);
    return null; // signal fallback
  }
}

// Ensure both AI slots are filled — top up from candidate articles if the
// model returned too few or dedup collapsed near-identical picks.
function padAISlots(headlines, candidates) {
  for (const a of candidates) {
    if (headlines.length >= AI_SLOT_COUNT) break;
    if (headlines.some(h => h.url === a.url)) continue;
    const title = cleanTitle(a.title);
    if (headlines.some(h => semanticSimilarity(h.headline, title) >= 0.6)) continue;
    headlines.push({
      headline: title,
      description: a.description?.slice(0, 100) || '',
      category: 'ai',
      breaking: false,
      updated: false,
      url: a.url,
    });
  }
  return headlines;
}

function aiFallback(articles) {
  const filtered = preFilterAIArticles(articles);
  return filtered.slice(0, AI_SLOT_COUNT).map(a => ({
    headline: cleanTitle(a.title),
    description: a.description?.slice(0, 100) || '',
    category: 'ai',
    breaking: false,
    updated: false,
    url: a.url,
  }));
}

function stampFirstSeen(headlines) {
  const now = Date.now();
  if (cachedHeadlines.length === 0) {
    return headlines.map(h => ({ ...h, firstSeenAt: 0 }));
  }
  return headlines.map(h => {
    if (!h.url) return { ...h, firstSeenAt: 0 };
    const prev = cachedHeadlines.find(c => c.url === h.url);
    if (prev) return { ...h, firstSeenAt: prev.firstSeenAt || 0 };
    return { ...h, firstSeenAt: now };
  });
}

// ── Fallback (when Ollama is unavailable) ─────────────────────────────

function fallbackHeadlines(articles, count = 7) {
  // Simple: pick 7 most recent from known-good sources, return raw titles
  const premium = ['bbc', 'guardian', 'reuters', 'associated press', 'nyt', 'new york times', 'al jazeera'];
  const sorted = articles
    .filter(a => a.title && a.url)
    .sort((a, b) => {
      const aP = premium.some(s => a.source.toLowerCase().includes(s)) ? 1 : 0;
      const bP = premium.some(s => b.source.toLowerCase().includes(s)) ? 1 : 0;
      return bP - aP;
    });

  // Rough dedup by first 5 words
  const seen = new Set();
  const unique = sorted.filter(a => {
    const key = a.title.toLowerCase().split(/\s+/).slice(0, 5).join(' ');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return unique.slice(0, count).map(a => ({
    headline: a.title,
    description: a.description?.slice(0, 100) || '',
    category: 'general',
    breaking: false,
    updated: false,
    url: a.url,
  }));
}

// ── Headlines Pipeline ────────────────────────────────────────────────

let cachedHeadlines = [];
let isFetching = false;
let rendererReady = false;
let lastPreFilterKeys = new Set();

function sendStatus(msg) {
  if (rendererReady && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('status-update', msg);
  }
  console.log('[status]', msg);
}

async function fetchAllHeadlines() {
  if (isFetching) return cachedHeadlines;
  isFetching = true;

  try {
    sendStatus('Fetching sources...');

    const [rss, newsapi, gnews, guardian, nyt, currents, aiRss] = await Promise.allSettled([
      fetchRSSFeeds(),
      fetchNewsAPI(),
      fetchGNews(),
      fetchGuardian(),
      fetchNYT(),
      fetchCurrents(),
      fetchAIFeeds(),
    ]);

    const allArticles = [rss, newsapi, gnews, guardian, nyt, currents]
      .filter(r => r.status === 'fulfilled')
      .flatMap(r => r.value)
      .filter(a => a.title && a.title.length > 5);

    const aiFeedArticles = (aiRss.status === 'fulfilled' ? aiRss.value : [])
      .filter(a => a.title && a.title.length > 5);

    console.log(`Fetched ${allArticles.length} world + ${aiFeedArticles.length} AI articles`);

    // Filter to last 24 hours only
    const recentArticles = filterLast24Hours(allArticles);
    console.log(`After 24h filter: ${recentArticles.length} articles`);

    if (recentArticles.length === 0) {
      sendStatus('No recent articles found');
      isFetching = false;
      return cachedHeadlines;
    }

    // Pre-filter to top candidates for Ollama
    const filtered = preFilterArticles(recentArticles);

    // Skip Ollama if articles haven't changed much since last fetch
    const currentKeys = new Set(filtered.map(a =>
      a.title.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).slice(0, 6).join(' ')
    ));
    if (cachedHeadlines.length > 0 && lastPreFilterKeys.size > 0) {
      const intersection = [...currentKeys].filter(k => lastPreFilterKeys.has(k)).length;
      const union = new Set([...currentKeys, ...lastPreFilterKeys]).size;
      const similarity = union > 0 ? intersection / union : 0;
      if (similarity > 0.7) {
        const now = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
        console.log(`Articles ${(similarity * 100).toFixed(0)}% similar, skipping Ollama`);
        sendStatus(`No major changes \u2014 ${now}`);
        lastPreFilterKeys = currentKeys;
        return cachedHeadlines;
      }
    }
    lastPreFilterKeys = currentKeys;

    sendStatus(`Analyzing ${recentArticles.length} recent articles with AI...`);

    const WORLD_COUNT = 7 - AI_SLOT_COUNT; // 2 AI slots + 5 world = 7 total

    let worldHeadlines = await queryOllama(filtered, recentArticles.length, WORLD_COUNT);

    if (!worldHeadlines) {
      console.warn('Ollama failed this cycle');
      if (cachedHeadlines.length > 0) {
        sendStatus('Ollama retry failed - keeping previous results');
        return cachedHeadlines;
      }
      sendStatus('Ollama unavailable - raw headlines');
      worldHeadlines = fallbackHeadlines(recentArticles, WORLD_COUNT);
    } else {
      const now = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
      sendStatus(`Updated ${now} (AI)`);
    }

    // Dedicated AI slots — drawn from AI feeds plus any AI stories already
    // surfaced in the world pool, then narrowed to AI-relevant content.
    const aiPool = filterLast24Hours([...aiFeedArticles, ...allArticles]);
    const aiCandidates = preFilterAIArticles(aiPool);
    let aiHeadlines = await queryOllamaAI(aiCandidates);
    if (!aiHeadlines) aiHeadlines = aiFallback(aiPool);
    console.log(`AI slots filled: ${aiHeadlines.length}`);

    // AI slots lead the feed so they sit together at the top, glanceable.
    let headlines = [...aiHeadlines, ...worldHeadlines];

    // Stamp firstSeenAt for new-story tracking
    headlines = stampFirstSeen(headlines);

    cachedHeadlines = headlines;
    return headlines;
  } catch (e) {
    console.error('Pipeline error:', e);
    return cachedHeadlines;
  } finally {
    isFetching = false;
  }
}


// ── App ───────────────────────────────────────────────────────────────

let mainWindow;

function createWindow() {
  const state = loadWindowState();

  const opts = {
    width: state.width || 300,
    height: state.height || 400,
    alwaysOnTop: true,
    frame: false,
    resizable: true,
    skipTaskbar: false,
    icon: path.join(__dirname, 'assets', 'icon.ico'),
    backgroundColor: '#0d1117',
    minWidth: 200,
    minHeight: 200,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: true,
    },
  };

  if (state.x !== undefined && state.y !== undefined && isPositionOnScreen(state.x, state.y)) {
    opts.x = state.x;
    opts.y = state.y;
  }

  mainWindow = new BrowserWindow(opts);
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'))
    .catch(e => console.error('Failed to load UI:', e));
  mainWindow.webContents.on('did-finish-load', () => { rendererReady = true; });

  // Prevent the window from ever navigating away from the app
  mainWindow.webContents.on('will-navigate', (event, url) => {
    event.preventDefault();
    if (isSafeUrl(url)) shell.openExternal(url).catch(e => console.warn('openExternal failed:', e.message));
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeUrl(url)) shell.openExternal(url).catch(e => console.warn('openExternal failed:', e.message));
    return { action: 'deny' };
  });

  let saveTimeout;
  const debouncedSave = () => {
    clearTimeout(saveTimeout);
    saveTimeout = setTimeout(() => {
      if (!mainWindow.isDestroyed()) {
        saveWindowState(mainWindow.getBounds());
      }
    }, 500);
  };

  mainWindow.on('move', debouncedSave);
  mainWindow.on('resize', debouncedSave);
  mainWindow.on('close', () => {
    if (!mainWindow.isDestroyed()) {
      saveWindowState(mainWindow.getBounds());
    }
  });

  // Refresh every 5 minutes (skip when minimized/hidden)
  const doRefresh = () => {
    fetchAllHeadlines().then(headlines => {
      if (!mainWindow.isDestroyed()) {
        mainWindow.webContents.send('headlines-updated', headlines);
      }
    }).catch(e => console.error('Auto-refresh failed:', e));
  };

  const refreshInterval = setInterval(() => {
    if (mainWindow.isDestroyed() || mainWindow.isMinimized() || !mainWindow.isVisible()) return;
    doRefresh();
  }, 5 * 60 * 1000);

  mainWindow.on('closed', () => clearInterval(refreshInterval));

  // Resume immediately when restored from minimized/hidden
  mainWindow.on('restore', doRefresh);
  mainWindow.on('show', doRefresh);
}

// ── IPC Handlers ──────────────────────────────────────────────────────

ipcMain.handle('get-headlines', async () => {
  return await fetchAllHeadlines();
});

ipcMain.handle('get-version', () => {
  return app.getVersion();
});

ipcMain.handle('refresh-now', async () => {
  return await fetchAllHeadlines();
});

ipcMain.on('close-window', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.close();
  }
});

ipcMain.on('open-external', (_, url) => {
  if (typeof url === 'string' && isSafeUrl(url)) {
    shell.openExternal(url).catch(e => console.warn('openExternal failed:', e.message));
  }
});

// ── Lifecycle ─────────────────────────────────────────────────────────

app.whenReady().then(() => {
  createWindow();
});

app.on('window-all-closed', () => {
  app.quit();
});
