/**
 * Service worker: owns capture sessions, the refresh schedule, de-duplicated
 * storage writes and retention pruning.
 */

import { addDocs, pruneOlderThan, getStats, clearAll, listHosts, setMeta, getMeta } from './lib/db.js';
import { getSettings, DEFAULT_SETTINGS, analysisOptionsFrom } from './lib/settings.js';
import { detectLang, findLongWords } from './lib/tokenize.js';
import { resolveSoundId, clampVolume } from './lib/sounds.js';

const SESSION_KEY = 'sessions';
const PRUNE_ALARM = 'wca:prune';
const REFRESH_PREFIX = 'wca:refresh:';

async function getSessions() {
  const data = await chrome.storage.session.get(SESSION_KEY);
  return data[SESSION_KEY] || {};
}

async function setSessions(sessions) {
  await chrome.storage.session.set({ [SESSION_KEY]: sessions });
}

async function getSession(tabId) {
  const sessions = await getSessions();
  return sessions[tabId] || null;
}

async function updateSession(tabId, patch) {
  const sessions = await getSessions();
  if (!sessions[tabId] && !patch) return null;
  const next = { ...(sessions[tabId] || {}), ...patch, tabId };
  sessions[tabId] = next;
  await setSessions(sessions);
  return next;
}

async function removeSession(tabId) {
  const sessions = await getSessions();
  delete sessions[tabId];
  await setSessions(sessions);
  await chrome.alarms.clear(`${REFRESH_PREFIX}${tabId}`);
  await refreshBadge();
}

async function refreshBadge() {
  const sessions = await getSessions();
  const count = Object.keys(sessions).length;
  await chrome.action.setBadgeBackgroundColor({ color: '#2f6feb' });
  await chrome.action.setBadgeText({ text: count ? String(count) : '' });
}

async function ensureContentScript(tabId) {
  try {
    const pong = await chrome.tabs.sendMessage(tabId, { type: 'PING' });
    if (pong?.ok) return true;
  } catch {
    // not injected yet
  }
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['src/content/content.js']
    });
    return true;
  } catch (err) {
    console.warn('[wca] cannot inject content script', err);
    return false;
  }
}

async function startSession(tabId) {
  const tab = await chrome.tabs.get(tabId);
  const settings = await getSettings();
  const url = new URL(tab.url);
  await updateSession(tabId, {
    host: url.host,
    url: tab.url,
    title: tab.title,
    startedAt: Date.now(),
    status: 'running',
    cycles: 0,
    added: 0,
    duplicates: 0,
    lastStats: null,
    nextRefreshAt: null
  });
  await refreshBadge();
  const injected = await ensureContentScript(tabId);
  if (!injected) {
    await updateSession(tabId, { status: 'error', lastError: 'Cannot run on this page' });
    return { ok: false, error: 'This page does not allow content scripts (e.g. chrome:// or the Web Store).' };
  }
  await chrome.tabs.sendMessage(tabId, { type: 'START_CYCLE', settings });
  return { ok: true };
}

async function stopSession(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'STOP_CYCLE' });
  } catch {
    // tab may be gone
  }
  await removeSession(tabId);
  return { ok: true };
}

async function scheduleRefresh(tabId, settings) {
  if (!settings.autoRefresh) {
    await updateSession(tabId, { status: 'idle', nextRefreshAt: null });
    return;
  }
  const minutes = Math.max(0.5, Number(settings.refreshIntervalMinutes) || DEFAULT_SETTINGS.refreshIntervalMinutes);
  await chrome.alarms.create(`${REFRESH_PREFIX}${tabId}`, { delayInMinutes: minutes });
  await updateSession(tabId, {
    status: 'waiting',
    nextRefreshAt: Date.now() + minutes * 60000
  });
}

async function handleCapture(msg, sender) {
  const ts = msg.ts || Date.now();
  const host = msg.host || (sender.tab?.url ? new URL(sender.tab.url).host : 'unknown');
  const docs = msg.items.map((item) => ({
    hash: item.hash,
    text: item.text,
    ts,
    host,
    url: msg.url,
    lang: detectLang(item.text)
  }));
  const result = await addDocs(docs);
  const tabId = sender.tab?.id;
  const longWords = await checkLongWords(result.addedItems || [], host);
  if (tabId != null) {
    const session = await getSession(tabId);
    if (session) {
      await updateSession(tabId, {
        added: (session.added || 0) + result.added,
        duplicates: (session.duplicates || 0) + result.duplicates,
        lastCaptureAt: ts,
        longWords: longWords.length
          ? [...longWords, ...(session.longWords || [])].slice(0, 20)
          : session.longWords || []
      });
    }
  }
  await setMeta('lastCaptureAt', ts);
  return { added: result.added, duplicates: result.duplicates, longWords };
}

/**
 * Report single words longer than the configured length and, if the user asked
 * for it, play a chime. Words already announced are remembered so the same one
 * does not keep ringing on every cycle.
 */
async function checkLongWords(addedItems, host) {
  const settings = await getSettings();
  if (!settings.longWordChars || !addedItems.length) return [];
  if (!settings.alertOnLongWord && !settings.hideLongWords) return [];

  const found = findLongWords(addedItems, settings.longWordChars, analysisOptionsFrom(settings));
  if (!found.length) return [];

  const announced = (await getMeta('announcedLongWords')) || {};
  const cutoff = Date.now() - 86400000;
  for (const [word, seenAt] of Object.entries(announced)) {
    if (seenAt < cutoff) delete announced[word];
  }

  const fresh = [];
  for (const term of found) {
    if (announced[term.text]) continue;
    announced[term.text] = Date.now();
    fresh.push({ text: term.text, lang: term.lang, host, ts: Date.now() });
  }
  await setMeta('announcedLongWords', announced);

  if (fresh.length && settings.alertOnLongWord) await playAlert(settings);
  return fresh;
}

let offscreenReady = null;

async function ensureOffscreen() {
  if (!chrome.offscreen) throw new Error('This Chrome build has no offscreen API (needs Chrome 116+)');
  // createDocument throws if one is already being created, so serialise callers.
  if (!offscreenReady) {
    offscreenReady = (async () => {
      const has = chrome.offscreen.hasDocument ? await chrome.offscreen.hasDocument() : false;
      if (has) return;
      await chrome.offscreen.createDocument({
        url: 'src/offscreen/offscreen.html',
        reasons: ['AUDIO_PLAYBACK'],
        justification: 'Play a chime when an unusually long word is captured.'
      });
    })().catch((err) => {
      offscreenReady = null;
      if (!/single offscreen document|already exists/i.test(String(err?.message || err))) throw err;
    });
  }
  await offscreenReady;
}

/**
 * Play the alert sound through an offscreen document (workers have no audio).
 * Returns the real reason on failure so the options page can show it.
 */
async function playAlert(settings) {
  const payload = {
    target: 'offscreen',
    type: 'PLAY_ALERT',
    sound: resolveSoundId(settings.alertSound),
    volume: clampVolume(settings.alertVolume)
  };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await ensureOffscreen();
      const reply = await chrome.runtime.sendMessage(payload);
      if (reply?.ok) return { ok: true };
      if (reply && reply.ok === false) return { ok: false, error: reply.error || 'the sound could not be played' };
      throw new Error('the offscreen document did not answer');
    } catch (err) {
      const message = String(err?.message || err);
      // A stale document reference: drop it and build a fresh one once.
      if (attempt === 0 && /Receiving end does not exist|did not answer|message port closed/i.test(message)) {
        offscreenReady = null;
        try {
          if (chrome.offscreen?.closeDocument) await chrome.offscreen.closeDocument();
        } catch {
          /* nothing to close */
        }
        continue;
      }
      return { ok: false, error: message };
    }
  }
  return { ok: false, error: 'the offscreen audio document could not be started' };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.target === 'offscreen') return false; // handled by the offscreen document
  (async () => {
    try {
      switch (msg?.type) {
        case 'CONTENT_READY': {
          const tabId = sender.tab?.id;
          const session = tabId != null ? await getSession(tabId) : null;
          if (!session) return sendResponse({ active: false });
          const settings = await getSettings();
          await updateSession(tabId, { status: 'running', url: msg.url, host: msg.host });
          return sendResponse({ active: true, settings });
        }
        case 'CAPTURE':
          return sendResponse(await handleCapture(msg, sender));
        case 'PROGRESS': {
          const tabId = sender.tab?.id;
          if (tabId != null) await updateSession(tabId, { lastStats: msg.stats, status: 'running' });
          return sendResponse({ ok: true });
        }
        case 'CYCLE_DONE': {
          const tabId = sender.tab?.id;
          if (tabId == null) return sendResponse({ ok: false });
          const session = await getSession(tabId);
          if (!session) return sendResponse({ ok: false });
          const settings = await getSettings();
          await updateSession(tabId, {
            cycles: (session.cycles || 0) + 1,
            lastStats: msg.stats,
            lastCycleAt: Date.now()
          });
          await scheduleRefresh(tabId, settings);
          return sendResponse({ ok: true });
        }
        case 'START_SESSION':
          return sendResponse(await startSession(msg.tabId));
        case 'STOP_SESSION':
          return sendResponse(await stopSession(msg.tabId));
        case 'GET_STATUS': {
          const sessions = await getSessions();
          const settings = await getSettings();
          const stats = await getStats();
          return sendResponse({
            sessions,
            settings,
            stats,
            session: msg.tabId != null ? sessions[msg.tabId] || null : null
          });
        }
        case 'GET_HOSTS':
          return sendResponse(await listHosts());
        case 'PRUNE_NOW': {
          const settings = await getSettings();
          const removed = await pruneOlderThan(Date.now() - settings.retentionDays * 86400000);
          return sendResponse({ removed });
        }
        case 'CLEAR_ALL':
          await clearAll();
          return sendResponse({ ok: true });
        case 'TEST_ALERT': {
          const settings = await getSettings();
          const result = await playAlert({
            ...settings,
            alertSound: msg.sound ?? settings.alertSound,
            alertVolume: msg.volume ?? settings.alertVolume
          });
          return sendResponse(result);
        }
        case 'SETTINGS_CHANGED': {
          const settings = await getSettings();
          const sessions = await getSessions();
          for (const tabId of Object.keys(sessions)) {
            const alarm = await chrome.alarms.get(`${REFRESH_PREFIX}${tabId}`);
            if (alarm) await scheduleRefresh(Number(tabId), settings);
          }
          return sendResponse({ ok: true });
        }
        default:
          return sendResponse({ ok: false, error: 'unknown message' });
      }
    } catch (err) {
      console.error('[wca] message error', msg?.type, err);
      return sendResponse({ ok: false, error: String(err?.message || err) });
    }
  })();
  return true;
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === PRUNE_ALARM) {
    const settings = await getSettings();
    const removed = await pruneOlderThan(Date.now() - settings.retentionDays * 86400000);
    await setMeta('lastPrune', { at: Date.now(), removed });
    return;
  }
  if (!alarm.name.startsWith(REFRESH_PREFIX)) return;

  const tabId = Number(alarm.name.slice(REFRESH_PREFIX.length));
  const session = await getSession(tabId);
  if (!session) return;
  try {
    await chrome.tabs.get(tabId); // throws if the tab is gone
    await updateSession(tabId, { status: 'refreshing', nextRefreshAt: null });
    await chrome.tabs.reload(tabId, { bypassCache: true });
    // The content script announces itself after the reload and starts a new cycle.
  } catch {
    await removeSession(tabId);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => removeSession(tabId));

chrome.runtime.onInstalled.addListener(async () => {
  await chrome.alarms.create(PRUNE_ALARM, { periodInMinutes: 60, delayInMinutes: 1 });
  const existing = await getMeta('installedAt');
  if (!existing) await setMeta('installedAt', Date.now());
  await refreshBadge();
});

chrome.runtime.onStartup.addListener(async () => {
  await chrome.alarms.create(PRUNE_ALARM, { periodInMinutes: 60, delayInMinutes: 1 });
  await setSessions({}); // tabs from the previous browser run are gone
  await refreshBadge();
});
