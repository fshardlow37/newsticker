const { app, BrowserWindow, ipcMain, shell, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');

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
      path: parsed.pathname,
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

async function fetchNewsAPI() {
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

// ── Ollama Integration ────────────────────────────────────────────────

const CATEGORY_COLORS = {
  global: '#4fc3f7',
  science: '#66bb6a',
  interests: '#ffa726',
  future: '#ab47bc',
  general: '#888',
};

function filterLast24Hours(articles) {
  const cutoff = Date.now() - (24 * 60 * 60 * 1000);
  return articles.filter(a => {
    if (!a.publishedAt) return true; // keep if no date (benefit of doubt)
    const parsed = new Date(a.publishedAt).getTime();
    if (isNaN(parsed)) return true; // keep if unparseable
    return parsed >= cutoff;
  });
}

function preFilterArticles(articles) {
  // Deduplicate by normalized first 6 words (keeps one per story angle)
  const seen = new Set();
  const unique = articles.filter(a => {
    const key = a.title.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).slice(0, 6).join(' ');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Count how many sources cover similar stories (significance signal)
  // Articles with titles sharing 3+ words with other articles get a boost
  const wordSets = unique.map(a =>
    new Set(a.title.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(w => w.length > 3))
  );

  const coverageScores = unique.map((a, i) => {
    let coverage = 0;
    for (let j = 0; j < wordSets.length; j++) {
      if (i === j) continue;
      const overlap = [...wordSets[i]].filter(w => wordSets[j].has(w)).length;
      if (overlap >= 3) coverage++;
    }
    return { article: a, coverage, index: i };
  });

  // Sort by coverage (most-covered stories first), take top 100
  coverageScores.sort((a, b) => b.coverage - a.coverage);
  return coverageScores.slice(0, 20).map(s => s.article);
}

async function queryOllama(articles) {
  // Pre-filter to top ~100 most-covered stories so Ollama can process quickly
  const filtered = preFilterArticles(articles);
  console.log(`Pre-filtered ${articles.length} → ${filtered.length} articles for Ollama`);

  const headlineList = filtered.map((a, i) =>
    `${i + 1}. [${a.source}] ${a.title}`
  ).join('\n');

  const prompt = `Below are ${filtered.length} real news headlines from the last 24 hours. Select the 7 most globally significant DISTINCT events. Each must be a DIFFERENT story — no two items about the same event. Only stories affecting millions of people, major geopolitical shifts, or major scientific advances. No opinion, no individual crime, no entertainment, no celebrity, no niche policy.

For each, write a neutral 7-10 word headline and a 15-20 word description. The description MUST add new information not in the headline — context, numbers, who, where, or consequences. Never repeat or rephrase the headline.

sourceIndex = the number of the headline from the list below.
Categories: global, science, interests, future, general
breaking=true if very recent, updated=true if ongoing story with new info.

Output ONLY valid JSON array, no other text. Exactly 7 items, each a DIFFERENT event.
[{"headline":"...","description":"...","category":"global","breaking":false,"updated":false,"sourceIndex":1}]

${headlineList}`;

  console.log(`Ollama prompt size: ${prompt.length} chars, ${filtered.length} headlines`);

  try {
    const response = await postJSON('http://localhost:11434/api/generate', {
      model: 'llama3.2:3b',
      prompt,
      stream: false,
      options: {
        temperature: 0.3,
        num_predict: 2048,
      },
    });

    const text = response.response || '';
    console.log('Ollama raw response:', text.slice(0, 500));

    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) throw new Error('No JSON array in Ollama response: ' + text.slice(0, 200));

    const items = JSON.parse(jsonMatch[0]);
    console.log('Ollama parsed keys:', items.length > 0 ? Object.keys(items[0]).join(', ') : 'empty');
    return items.slice(0, 7).map(item => {
      const srcIdx = (item.sourceIndex || 1) - 1;
      const srcArticle = filtered[srcIdx] || filtered[0];
      return {
        headline: item.headline || item.title || 'Untitled',
        description: item.description || item.summary || item.desc || '',
        category: item.category || 'general',
        color: CATEGORY_COLORS[item.category] || CATEGORY_COLORS.general,
        breaking: !!item.breaking,
        updated: !!item.updated,
        url: srcArticle?.url || '',
      };
    });
  } catch (e) {
    console.error('Ollama failed:', e.message, e.stack);
    return null; // signal fallback needed
  }
}

// ── Fallback (when Ollama is unavailable) ─────────────────────────────

function fallbackHeadlines(articles) {
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

  return unique.slice(0, 7).map(a => ({
    headline: a.title,
    description: a.description?.slice(0, 100) || '',
    category: 'general',
    color: CATEGORY_COLORS.general,
    breaking: false,
    updated: false,
    url: a.url,
  }));
}

// ── Headlines Pipeline ────────────────────────────────────────────────

let cachedHeadlines = [];
let isFetching = false;
let rendererReady = false;

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

    const [rss, newsapi, gnews, guardian, nyt, currents] = await Promise.allSettled([
      fetchRSSFeeds(),
      fetchNewsAPI(),
      fetchGNews(),
      fetchGuardian(),
      fetchNYT(),
      fetchCurrents(),
    ]);

    const allArticles = [rss, newsapi, gnews, guardian, nyt, currents]
      .filter(r => r.status === 'fulfilled')
      .flatMap(r => r.value)
      .filter(a => a.title && a.title.length > 5);

    console.log(`Fetched ${allArticles.length} articles from all sources`);

    // Filter to last 24 hours only
    const recentArticles = filterLast24Hours(allArticles);
    console.log(`After 24h filter: ${recentArticles.length} articles`);

    if (recentArticles.length === 0) {
      sendStatus('No recent articles found');
      isFetching = false;
      return cachedHeadlines;
    }

    sendStatus(`Analyzing ${recentArticles.length} recent articles with AI...`);

    let headlines = await queryOllama(recentArticles);

    if (!headlines) {
      console.warn('Ollama failed this cycle');
      // If we already have good AI results, keep them instead of replacing with junk
      if (cachedHeadlines.length > 0) {
        sendStatus('Ollama retry failed - keeping previous results');
        return cachedHeadlines;
      }
      // Only use fallback if we have nothing at all
      sendStatus('Ollama unavailable - raw headlines');
      headlines = fallbackHeadlines(recentArticles);
    } else {
      const now = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
      sendStatus(`Updated ${now} (AI)`);
    }

    cachedHeadlines = headlines;
    return headlines;
  } catch (e) {
    console.error('Pipeline error:', e);
    return cachedHeadlines;
  } finally {
    isFetching = false;
  }
}

// ── Auto-start ────────────────────────────────────────────────────────

function setupAutoStart() {
  try {
    app.setLoginItemSettings({
      openAtLogin: true,
      path: process.execPath,
    });
  } catch (e) {
    console.error('Failed to set auto-start:', e);
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
    },
  };

  if (state.x !== undefined && state.y !== undefined && isPositionOnScreen(state.x, state.y)) {
    opts.x = state.x;
    opts.y = state.y;
  }

  mainWindow = new BrowserWindow(opts);
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.webContents.on('did-finish-load', () => { rendererReady = true; });

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

  // Refresh every 15 minutes
  setInterval(() => {
    fetchAllHeadlines().then(headlines => {
      if (!mainWindow.isDestroyed()) {
        mainWindow.webContents.send('headlines-updated', headlines);
      }
    });
  }, 15 * 60 * 1000);
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
  if (url && (url.startsWith('http://') || url.startsWith('https://'))) {
    shell.openExternal(url);
  }
});

// ── Lifecycle ─────────────────────────────────────────────────────────

app.whenReady().then(() => {
  createWindow();
  setupAutoStart();
});

app.on('window-all-closed', () => {
  app.quit();
});
