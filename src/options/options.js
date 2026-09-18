import { getSettings, saveSettings, DEFAULT_SETTINGS } from '../lib/settings.js';
import { getStats } from '../lib/db.js';
import { SOUND_PRESETS, playSound, resolveSoundId, clampVolume } from '../lib/sounds.js';

const $ = (id) => document.getElementById(id);

const NUMBER_FIELDS = [
  'refreshIntervalMinutes', 'maxScrolls', 'scrollDelayMs', 'idleRoundsToStop', 'duplicateStopRatio',
  'cycleTimeoutMs', 'minTextLength', 'maxTextLength', 'retentionDays', 'shortWindowMinutes',
  'longWindowDays', 'minCount', 'maxTerms', 'longWordChars', 'alertVolume'
];
const BOOL_FIELDS = [
  'autoRefresh', 'includeSingleChars', 'includePhrases', 'includeHashtags', 'includeMentions',
  'hideLongWords', 'alertOnLongWord'
];
const TEXT_FIELDS = ['weightBy', 'alertSound'];

function fillSoundChoices() {
  const select = $('alertSound');
  select.innerHTML = '';
  for (const preset of SOUND_PRESETS) {
    const option = document.createElement('option');
    option.value = preset.id;
    option.textContent = preset.label;
    select.appendChild(option);
  }
}

function fill(settings) {
  for (const id of NUMBER_FIELDS) $(id).value = settings[id];
  for (const id of BOOL_FIELDS) $(id).checked = Boolean(settings[id]);
  for (const id of TEXT_FIELDS) $(id).value = settings[id];
  $('extraStopwords').value = (settings.extraStopwords || []).join('\n');
}

function collect() {
  const patch = {};
  for (const id of NUMBER_FIELDS) patch[id] = Number($(id).value);
  for (const id of BOOL_FIELDS) patch[id] = $(id).checked;
  for (const id of TEXT_FIELDS) patch[id] = $(id).value;
  patch.extraStopwords = $('extraStopwords')
    .value.split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  patch.refreshIntervalMinutes = Math.max(0.5, patch.refreshIntervalMinutes || 5);
  patch.duplicateStopRatio = Math.min(1, Math.max(0.1, patch.duplicateStopRatio || 0.9));
  patch.longWordChars = Math.max(0, Math.round(patch.longWordChars || 0));
  patch.alertVolume = Math.min(1, Math.max(0, Number.isFinite(patch.alertVolume) ? patch.alertVolume : 0.3));
  patch.alertSound = resolveSoundId(patch.alertSound);
  return patch;
}

async function refreshStats() {
  const stats = await getStats();
  $('dataStats').textContent = stats.total
    ? `${stats.total} text blocks stored · oldest ${new Date(stats.oldest).toLocaleString()} · newest ${new Date(
        stats.newest
      ).toLocaleString()}`
    : 'No content captured yet.';
}

async function init() {
  fillSoundChoices();
  fill(await getSettings());
  await refreshStats();

  $('saveBtn').addEventListener('click', async () => {
    await saveSettings(collect());
    await chrome.runtime.sendMessage({ type: 'SETTINGS_CHANGED' });
    $('saved').textContent = 'Saved';
    setTimeout(() => ($('saved').textContent = ''), 1500);
  });

  $('resetBtn').addEventListener('click', async () => {
    fill(DEFAULT_SETTINGS);
    await saveSettings(DEFAULT_SETTINGS);
    await chrome.runtime.sendMessage({ type: 'SETTINGS_CHANGED' });
  });

  $('pruneBtn').addEventListener('click', async () => {
    const result = await chrome.runtime.sendMessage({ type: 'PRUNE_NOW' });
    $('saved').textContent = `Removed ${result?.removed ?? 0} old blocks`;
    await refreshStats();
  });

  $('clearBtn').addEventListener('click', async () => {
    if (!confirm('Delete all captured content? This cannot be undone.')) return;
    await chrome.runtime.sendMessage({ type: 'CLEAR_ALL' });
    await refreshStats();
  });

  $('alertSound').addEventListener('change', () => {
    playSound($('alertSound').value, Number($('alertVolume').value)).catch(() => {});
  });

  $('testAlertBtn').addEventListener('click', async () => {
    const sound = resolveSoundId($('alertSound').value);
    const volume = clampVolume($('alertVolume').value);
    await saveSettings({ alertSound: sound, alertVolume: volume });

    // Play it right here first: this click is a user gesture, so it always works
    // and tells you what the alert will sound like.
    let localError = '';
    try {
      await playSound(sound, volume);
    } catch (err) {
      localError = String(err?.message || err);
    }

    // Then check the path a real alert uses, so a broken one is visible.
    let background = null;
    try {
      background = await chrome.runtime.sendMessage({ type: 'TEST_ALERT', sound, volume });
    } catch (err) {
      background = { ok: false, error: String(err?.message || err) };
    }

    if (!localError) {
      $('saved').textContent = volume === 0 ? 'Volume is 0 — nothing to hear' : 'Played test sound';
    } else {
      $('saved').textContent = 'Could not play here';
    }
    $('alertDiag').textContent = background?.ok
      ? ''
      : `Background alerts are not working: ${background?.error || 'unknown error'}${
          localError ? ` · this page also failed: ${localError}` : ''
        }`;
    setTimeout(() => ($('saved').textContent = ''), 2000);
  });
}

init();
