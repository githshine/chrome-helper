/**
 * Offscreen document: the only place an MV3 extension can play audio, because
 * the service worker has no DOM.
 */
import { playSound, soundDuration } from '../lib/sounds.js';

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== 'offscreen') return false;
  if (msg.type !== 'PLAY_ALERT') return false;

  playSound(msg.sound, msg.volume)
    .then(() => sendResponse({ ok: true, durationMs: Math.ceil(soundDuration(msg.sound) * 1000) }))
    .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
  return true; // keep the channel open for the async reply
});
