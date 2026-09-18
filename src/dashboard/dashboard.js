import { getDocsInRange, listHosts, getStats } from '../lib/db.js';
import { analyze, compareTerms } from '../lib/tokenize.js';
import { getSettings, saveSettings, analysisOptionsFrom } from '../lib/settings.js';
import { renderWordCloud, hitTest } from '../lib/wordcloud.js';

const $ = (id) => document.getElementById(id);

const WINDOWS = {
  '30m': 30 * 60000,
  '1h': 3600000,
  '3h': 3 * 3600000,
  '6h': 6 * 3600000,
  '24h': 86400000,
  '3d': 3 * 86400000,
  '7d': 7 * 86400000
};

const WINDOW_LABELS = {
  '30m': 'last 30 minutes',
  '1h': 'last hour',
  '3h': 'last 3 hours',
  '6h': 'last 6 hours',
  '24h': 'last 24 hours',
  '3d': 'last 3 days',
  '7d': 'last 7 days'
};

const state = {
  settings: null,
  docs: [],
  analysis: null,
  compareAnalysis: null,
  placed: [],
  comparePlaced: []
};

function langFilter(docs, lang) {
  if (lang === 'all') return docs;
  if (lang === 'zh') return docs.filter((d) => d.lang === 'zh' || d.lang === 'mixed');
  return docs.filter((d) => d.lang === 'en' || d.lang === 'mixed');
}

function fmtTime(ts) {
  return new Date(ts).toLocaleString();
}

function fmtRelative(ts) {
  if (!ts) return '—';
  const diff = Date.now() - ts;
  const minutes = Math.round(diff / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

function escapeHtml(str) {
  return str.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function loadHosts(selected) {
  const hosts = await listHosts();
  const select = $('host');
  select.innerHTML = '<option value="">All sites</option>';
  for (const { host, count } of hosts) {
    const opt = document.createElement('option');
    opt.value = host;
    opt.textContent = `${host} (${count})`;
    select.appendChild(opt);
  }
  if (selected && hosts.some((h) => h.host === selected)) select.value = selected;
}

function compareRange(primaryFrom, primaryTo) {
  const mode = $('compare').value;
  if (mode === 'none') return null;
  if (mode === 'previous') {
    const length = primaryTo - primaryFrom;
    return { from: primaryFrom - length, to: primaryFrom, label: `previous ${WINDOW_LABELS[$('window').value]}` };
  }
  const span = WINDOWS[mode];
  return { from: Date.now() - span, to: Date.now(), label: WINDOW_LABELS[mode] };
}

function renderSummary(dbStats, from, to, compare) {
  const langMix = state.analysis.langMix;
  const capturedLast = state.docs.length ? Math.max(...state.docs.map((d) => d.ts)) : null;
  const metrics = [
    ['Posts / blocks in window', state.docs.length],
    ['Distinct words ranked', state.analysis.allTerms.length],
    ['中文 blocks', (langMix.zh || 0) + (langMix.mixed || 0)],
    ['English blocks', (langMix.en || 0) + (langMix.mixed || 0)],
    ['Newest capture', fmtRelative(capturedLast)],
    ['Stored total', dbStats.total]
  ];
  $('summary').innerHTML = metrics
    .map(([label, value]) => `<div class="metric"><b>${escapeHtml(String(value))}</b><span>${label}</span></div>`)
    .join('');
  $('cloudTitle').textContent = `Word cloud · ${WINDOW_LABELS[$('window').value]} (${fmtTime(from)} → ${fmtTime(to)})`;
  $('comparePanel').hidden = !compare;
}

function renderCloud() {
  const terms = state.analysis.terms;
  $('cloudEmpty').hidden = terms.length > 0;
  $('cloud').hidden = terms.length === 0;
  state.placed = terms.length ? renderWordCloud($('cloud'), terms) : [];
}

function renderCompareCloud(compare) {
  if (!compare || !state.compareAnalysis) return;
  $('compareTitle').textContent = `Comparison cloud · ${compare.label}`;
  $('compareMeta').textContent = `${state.compareAnalysis.docCount} blocks · ${fmtTime(compare.from)} → ${fmtTime(
    compare.to
  )}`;
  state.comparePlaced = renderWordCloud($('compareCloud'), state.compareAnalysis.terms, { maxFontSize: 48 });
}

function renderTopTerms() {
  const rows = state.analysis.terms
    .slice(0, 100)
    .map(
      (t, i) => `<tr class="term-row" data-term="${escapeHtml(t.text)}">
        <td class="muted mono">${i + 1}</td>
        <td>${escapeHtml(t.text)} <span class="lang-tag">${t.lang}</span></td>
        <td class="mono">${t.docFreq}</td>
        <td class="mono">${t.count}</td>
      </tr>`
    )
    .join('');
  $('tab-top').innerHTML = rows
    ? `<table><thead><tr><th>#</th><th>Word</th><th>Posts</th><th>Uses</th></tr></thead><tbody>${rows}</tbody></table>`
    : '<p class="muted">Nothing to show for this window.</p>';
}

function renderTrending() {
  if (!state.compareAnalysis) {
    $('tab-trend').innerHTML = '<p class="muted">Comparison is turned off.</p>';
    return;
  }
  const rows = compareTerms(state.analysis.terms, state.compareAnalysis.terms)
    .filter((r) => r.current > 0 || r.previous > 0)
    .slice(0, 80)
    .map(
      (r) => `<tr class="term-row" data-term="${escapeHtml(r.text)}">
        <td>${escapeHtml(r.text)}</td>
        <td class="mono">${r.current}</td>
        <td class="mono">${r.previous}</td>
        <td class="mono ${r.delta > 0 ? 'up' : r.delta < 0 ? 'down' : ''}">${r.delta > 0 ? '+' : ''}${r.delta}</td>
      </tr>`
    )
    .join('');
  $('tab-trend').innerHTML = `<table><thead><tr><th>Word</th><th>Now</th><th>Before</th><th>Δ</th></tr></thead><tbody>${rows}</tbody></table>`;
}

/** Rank captured blocks by how many of the window's top words they contain. */
function representativeDocs(limit = 60) {
  const weights = new Map(state.analysis.terms.slice(0, 40).map((t) => [t.text, t.weight]));
  return state.docs
    .map((doc) => {
      let score = 0;
      const lower = doc.text.toLowerCase();
      for (const [term, weight] of weights) {
        if (lower.includes(term)) score += weight;
      }
      return { doc, score };
    })
    .sort((a, b) => b.score - a.score || b.doc.ts - a.doc.ts)
    .slice(0, limit);
}

function renderDocs() {
  const items = representativeDocs();
  $('tab-docs').innerHTML = items.length
    ? items
        .map(
          ({ doc }) => `<div class="doc">
            <time>${fmtTime(doc.ts)} · ${escapeHtml(doc.host)}</time>
            <p>${escapeHtml(doc.text.slice(0, 400))}</p>
          </div>`
        )
        .join('')
    : '<p class="muted">No posts captured in this window.</p>';
}

function showDetail(termText) {
  const term = state.analysis.allTerms.find((t) => t.text === termText);
  if (!term) return;
  const matches = state.docs.filter((d) => d.text.toLowerCase().includes(termText)).slice(0, 25);
  $('detailTerm').textContent = `${term.text} — ${term.docFreq} posts, ${term.count} uses`;
  $('detailBody').innerHTML = matches
    .map(
      (d) => `<div class="doc"><time>${fmtTime(d.ts)}</time><p>${escapeHtml(d.text.slice(0, 400))}</p></div>`
    )
    .join('');
  $('detail').hidden = false;
}

function exportCsv() {
  const header = 'word,language,posts,occurrences\n';
  const body = state.analysis.allTerms
    .map((t) => `"${t.text.replace(/"/g, '""')}",${t.lang},${t.docFreq},${t.count}`)
    .join('\n');
  const blob = new Blob([`\ufeff${header}${body}`], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `wordcloud-${$('window').value}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

async function run() {
  const settings = state.settings;
  const windowKey = $('window').value;
  const to = Date.now();
  const from = to - WINDOWS[windowKey];
  const host = $('host').value || undefined;
  const lang = $('lang').value;

  const options = {
    ...analysisOptionsFrom(settings),
    weightBy: $('weightBy').value,
    minCount: Math.max(1, Number($('minCount').value) || 1),
    maxTerms: Math.max(20, Number($('maxTerms').value) || 150)
  };

  const [docs, dbStats] = await Promise.all([getDocsInRange(from, to, { host }), getStats()]);
  state.docs = langFilter(docs, lang);
  state.analysis = analyze(state.docs, options);

  const compare = compareRange(from, to);
  if (compare) {
    const compareDocs = langFilter(await getDocsInRange(compare.from, compare.to, { host }), lang);
    state.compareAnalysis = analyze(compareDocs, options);
  } else {
    state.compareAnalysis = null;
  }

  renderSummary(dbStats, from, to, compare);
  renderCloud();
  renderCompareCloud(compare);
  renderTopTerms();
  renderTrending();
  renderDocs();
}

function wireTabs() {
  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab));
      ['top', 'trend', 'docs'].forEach((name) => {
        $(`tab-${name}`).hidden = name !== tab.dataset.tab;
      });
    });
  });
}

function wireCanvas(canvas, getPlaced) {
  canvas.addEventListener('click', (event) => {
    const rect = canvas.getBoundingClientRect();
    const hit = hitTest(getPlaced(), event.clientX - rect.left, event.clientY - rect.top);
    if (hit) showDetail(hit.term.text);
  });
}

async function init() {
  state.settings = await getSettings();
  const params = new URLSearchParams(location.search);
  const windowKey = params.get('window');
  if (windowKey && WINDOWS[windowKey]) $('window').value = windowKey;

  $('weightBy').value = state.settings.weightBy;
  $('minCount').value = state.settings.minCount;
  $('maxTerms').value = state.settings.maxTerms;

  await loadHosts(params.get('host') || '');

  wireTabs();
  wireCanvas($('cloud'), () => state.placed);
  wireCanvas($('compareCloud'), () => state.comparePlaced);

  $('detailClose').addEventListener('click', () => {
    $('detail').hidden = true;
  });
  $('exportCsv').addEventListener('click', exportCsv);

  ['host', 'window', 'compare', 'lang'].forEach((id) => $(id).addEventListener('change', run));
  ['weightBy', 'minCount', 'maxTerms'].forEach((id) =>
    $(id).addEventListener('change', async () => {
      await saveSettings({
        weightBy: $('weightBy').value,
        minCount: Math.max(1, Number($('minCount').value) || 1),
        maxTerms: Math.max(20, Number($('maxTerms').value) || 150)
      });
      state.settings = await getSettings();
      run();
    })
  );
  $('reload').addEventListener('click', run);

  document.addEventListener('click', (event) => {
    const row = event.target.closest('.term-row');
    if (row) showDetail(row.dataset.term);
  });

  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      renderCloud();
      if (state.compareAnalysis) {
        state.comparePlaced = renderWordCloud($('compareCloud'), state.compareAnalysis.terms, { maxFontSize: 48 });
      }
    }, 250);
  });

  await run();
  setInterval(run, 60000);
}

init();
