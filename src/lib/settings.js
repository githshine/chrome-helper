/**
 * Settings shared by the popup, options page, dashboard and service worker.
 */

export const DEFAULT_SETTINGS = {
  // Capture cycle
  autoRefresh: true,
  refreshIntervalMinutes: 5,
  maxScrolls: 40,
  scrollDelayMs: 900,
  idleRoundsToStop: 3,
  duplicateStopRatio: 0.9,
  cycleTimeoutMs: 150000,
  minTextLength: 12,
  maxTextLength: 2000,

  // Retention / analysis
  retentionDays: 7,
  shortWindowMinutes: 30,
  longWindowDays: 7,
  weightBy: 'docFreq',
  minCount: 2,
  maxTerms: 150,
  includeSingleChars: false,
  includePhrases: true,
  includeHashtags: true,
  includeMentions: false,
  extraStopwords: [],

  // Long single words (no spaces): 0 disables both behaviours below.
  longWordChars: 15,
  hideLongWords: false,
  alertOnLongWord: false,
  alertSound: 'chime',
  alertVolume: 0.3
};

export async function getSettings() {
  const stored = await chrome.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...(stored.settings || {}) };
}

export async function saveSettings(patch) {
  const current = await getSettings();
  const next = { ...current, ...patch };
  await chrome.storage.local.set({ settings: next });
  return next;
}

export function analysisOptionsFrom(settings) {
  return {
    weightBy: settings.weightBy,
    minCount: settings.minCount,
    maxTerms: settings.maxTerms,
    includeSingleChars: settings.includeSingleChars,
    includePhrases: settings.includePhrases,
    includeHashtags: settings.includeHashtags,
    includeMentions: settings.includeMentions,
    extraStopwords: settings.extraStopwords,
    maxWordChars: settings.hideLongWords ? settings.longWordChars : 0
  };
}
