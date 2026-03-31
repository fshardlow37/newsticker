const headlinesEl = document.getElementById('headlines');
const versionEl = document.getElementById('version');
const statusBar = document.getElementById('status-bar');
const btnClose = document.getElementById('btn-close');
const btnRefresh = document.getElementById('btn-refresh');

btnClose.addEventListener('click', () => window.api.closeWindow());

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
    return;
  }

  headlinesEl.innerHTML = headlines.map(h => {
    const classes = ['headline'];
    if (h.breaking) classes.push('breaking');
    if (h.updated) classes.push('updated');

    return `
      <div class="${classes.join(' ')}" data-url="${escapeAttr(h.url)}" title="${escapeAttr(h.headline)}">
        <div class="headline-indicator" style="background: ${h.color}"></div>
        <div class="headline-content">
          <div class="headline-text">${escapeHtml(h.headline)}</div>
          <div class="headline-desc">${escapeHtml(h.description)}</div>
        </div>
      </div>
    `;
  }).join('');

  headlinesEl.querySelectorAll('.headline').forEach(el => {
    el.addEventListener('click', () => {
      const url = el.dataset.url;
      if (url) window.api.openExternal(url);
    });
  });

}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function escapeAttr(text) {
  return (text || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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
  const version = await window.api.getVersion();
  versionEl.textContent = `v${version}`;
  await loadHeadlines();
}

window.api.onHeadlinesUpdated((headlines) => renderHeadlines(headlines));
window.api.onStatusUpdate((msg) => { statusBar.textContent = msg; });

init();
