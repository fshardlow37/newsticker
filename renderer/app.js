const headlinesEl = document.getElementById('headlines');
const versionEl = document.getElementById('version');
const statusBar = document.getElementById('status-bar');
const btnClose = document.getElementById('btn-close');
const btnRefresh = document.getElementById('btn-refresh');

btnClose.addEventListener('click', () => window.api.closeWindow());

let newStoryTimers = [];
let lastHeadlineKey = '';

btnRefresh.addEventListener('click', async () => {
  btnRefresh.style.opacity = '0.3';
  btnRefresh.style.pointerEvents = 'none';
  await loadHeadlines();
  btnRefresh.style.opacity = '1';
  btnRefresh.style.pointerEvents = 'auto';
});

function renderHeadlines(headlines) {
  if (!headlines || headlines.length === 0) {
    headlinesEl.innerHTML = '<div class="loading">No headlines available</div>';
    lastHeadlineKey = '';
    return;
  }

  // Skip DOM rebuild if headlines haven't changed
  const key = headlines.map(h => h.headline + '\0' + h.url + '\0' + (h.breaking || '') + (h.updated || '')).join('|');
  if (key === lastHeadlineKey) return;
  lastHeadlineKey = key;

  newStoryTimers.forEach(t => clearTimeout(t));
  newStoryTimers = [];

  headlinesEl.innerHTML = headlines.map(h => {
    const classes = ['headline'];
    if (h.category === 'ai') classes.push('ai-slot');
    if (h.breaking) classes.push('breaking');
    if (h.updated) classes.push('updated');
    if (h.firstSeenAt && (Date.now() - h.firstSeenAt < 10 * 60 * 1000)) classes.push('new-story');

    return `
      <div class="${classes.join(' ')}" data-url="${escapeAttr(h.url)}" data-first-seen="${h.firstSeenAt || 0}" title="${escapeAttr(h.headline)}">
        <div class="headline-indicator" data-category="${escapeAttr(h.category || 'general')}"></div>
        <div class="headline-content">
          <div class="headline-text">${escapeHtml(h.headline)}</div>
          <div class="headline-desc">${escapeHtml(h.description)}</div>
        </div>
      </div>
    `;
  }).join('');

  // Auto-expire new-story highlights after 10 minutes
  headlinesEl.querySelectorAll('.headline.new-story').forEach(el => {
    const firstSeen = parseInt(el.dataset.firstSeen, 10);
    if (firstSeen > 0) {
      const remaining = (10 * 60 * 1000) - (Date.now() - firstSeen);
      if (remaining > 0) {
        newStoryTimers.push(setTimeout(() => el.classList.remove('new-story'), remaining));
      }
    }
  });

}

function escapeHtml(text) {
  return String(text ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function escapeAttr(text) {
  return String(text ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function formatTime(date) {
  return date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

async function loadHeadlines() {
  try {
    const headlines = await window.api.getHeadlines();
    renderHeadlines(headlines);
  } catch (e) {
    headlinesEl.textContent = '';
    const div = document.createElement('div');
    div.className = 'loading';
    div.textContent = `Error: ${e.message}`;
    headlinesEl.appendChild(div);
  }
}

async function init() {
  // Single delegated click listener for all headlines
  headlinesEl.addEventListener('click', (e) => {
    const el = e.target.closest('.headline');
    if (el?.dataset.url) window.api.openExternal(el.dataset.url);
  });

  const version = await window.api.getVersion();
  versionEl.textContent = `v${version}`;
  await loadHeadlines();
}

window.api.onHeadlinesUpdated((headlines) => renderHeadlines(headlines));
window.api.onStatusUpdate((msg) => { statusBar.textContent = msg; });

init().catch(e => {
  statusBar.textContent = `Init error: ${e.message}`;
});
