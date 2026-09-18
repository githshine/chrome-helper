import { getSettings, saveSettings } from '../lib/settings.js';

const $ = (id) => document.getElementById(id);
let currentTab = null;
let timer = null;

function fmtCountdown(ts) {
  if (!ts) return '—';
  const diff = Math.max(0, ts - Date.now());
  const m = Math.floor(diff / 60000);
  const s = Math.floor((diff % 60000) / 1000);
  return `${m}:${String(s).padStart(2, '0')}`;
}

async function send(message) {
  return chrome.runtime.sendMessage(message);
}

function describeStats(stats) {
  if (!stats) return '';
  const reason = {
    completed: 'completed',
    stopped: 'stopped by you',
    timeout: 'timed out',
    'max-scrolls': 'scroll limit reached',
    'reached-known-content': 'reached already-seen content',
    'no-new-content': 'no new content',
    'end-of-page': 'end of page'
  }[stats.stopReason] || stats.stopReason;
  return `Last cycle: ${stats.rounds} scrolls · ${stats.added} new · ${stats.duplicates} repeats · ${reason}`;
}

async function render() {
  const status = await send({ type: 'GET_STATUS', tabId: currentTab?.id });
  const session = status.session;
  const settings = status.settings;

  $('autoRefresh').checked = settings.autoRefresh;
  if (document.activeElement !== $('refreshInterval')) {
    $('refreshInterval').value = settings.refreshIntervalMinutes;
  }

  const state = session?.status || 'idle';
  const pill = $('sessionState');
  pill.textContent = state;
  pill.className = `pill ${['running', 'waiting', 'error'].includes(state) ? state : ''}`;

  $('toggleBtn').textContent = session ? 'Stop capturing' : 'Start capturing';
  $('toggleBtn').classList.toggle('primary', !session);
  $('toggleBtn').classList.toggle('danger', Boolean(session));

  $('sessionAdded').textContent = session?.added ?? 0;
  $('sessionCycles').textContent = session?.cycles ?? 0;
  $('totalDocs').textContent = status.stats.total;
  $('lastStats').textContent = describeStats(session?.lastStats);
  $('nextRefresh').textContent = fmtCountdown(session?.nextRefreshAt);

  const longWords = session?.longWords || [];
  $('longWords').hidden = longWords.length === 0;
  if (longWords.length) {
    $('longWords').textContent = `Long words: ${longWords.slice(0, 5).map((w) => w.text).join(', ')}`;
  }
  if (session?.lastError) {
    $('error').hidden = false;
    $('error').textContent = session.lastError;
  } else {
    $('error').hidden = true;
  }
}

function openDashboard(windowKey) {
  const url = chrome.runtime.getURL(
    `src/dashboard/dashboard.html?window=${encodeURIComponent(windowKey)}&host=${encodeURIComponent(
      currentTab ? new URL(currentTab.url).host : ''
    )}`
  );
  chrome.tabs.create({ url });
}

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTab = tab;
  try {
    $('tabHost').textContent = new URL(tab.url).host || tab.url;
  } catch {
    $('tabHost').textContent = tab?.url || 'unknown page';
  }

  $('toggleBtn').addEventListener('click', async () => {
    const status = await send({ type: 'GET_STATUS', tabId: tab.id });
    if (status.session) {
      await send({ type: 'STOP_SESSION', tabId: tab.id });
    } else {
      const result = await send({ type: 'START_SESSION', tabId: tab.id });
      if (!result?.ok) {
        $('error').hidden = false;
        $('error').textContent = result?.error || 'Could not start on this page.';
      }
    }
    render();
  });

  $('autoRefresh').addEventListener('change', async () => {
    await saveSettings({ autoRefresh: $('autoRefresh').checked });
    await send({ type: 'SETTINGS_CHANGED' });
    render();
  });

  $('refreshInterval').addEventListener('change', async () => {
    const value = Math.max(0.5, Number($('refreshInterval').value) || 5);
    await saveSettings({ refreshIntervalMinutes: value });
    await send({ type: 'SETTINGS_CHANGED' });
    render();
  });

  $('dashboardBtn').addEventListener('click', () => openDashboard('30m'));
  $('optionsBtn').addEventListener('click', () => chrome.runtime.openOptionsPage());
  document.querySelectorAll('[data-window]').forEach((btn) => {
    btn.addEventListener('click', () => openDashboard(btn.dataset.window));
  });

  await getSettings();
  await render();
  timer = setInterval(render, 1000);
  window.addEventListener('unload', () => clearInterval(timer));
}

init();
