/**
 * Alert sounds, synthesised with Web Audio so the extension ships no binary
 * assets. Every preset is a plain list of notes, which means the exact same
 * code can be rendered into an OfflineAudioContext by the tests and into a
 * live AudioContext by the offscreen document and the options page.
 */

export const SOUND_PRESETS = [
  { id: 'chime', label: 'Chime — two rising tones' },
  { id: 'ping', label: 'Ping — one soft tone' },
  { id: 'bell', label: 'Bell — long decay' },
  { id: 'marimba', label: 'Marimba — warm wooden note' },
  { id: 'alert', label: 'Alert — three quick beeps' },
  { id: 'buzz', label: 'Buzz — low and urgent' }
];

export const DEFAULT_SOUND = 'chime';

/** at/dur in seconds, gain relative to the configured volume. */
const VOICES = {
  chime: [
    { freq: 880, at: 0, dur: 0.16, type: 'sine' },
    { freq: 1320, at: 0.16, dur: 0.18, type: 'sine' }
  ],
  ping: [{ freq: 1200, at: 0, dur: 0.18, type: 'sine' }],
  bell: [
    { freq: 660, at: 0, dur: 1.1, type: 'sine' },
    { freq: 1979, at: 0, dur: 0.9, type: 'sine', gain: 0.35 },
    { freq: 2640, at: 0, dur: 0.5, type: 'sine', gain: 0.15 }
  ],
  marimba: [
    { freq: 523, at: 0, dur: 0.35, type: 'triangle' },
    { freq: 1046, at: 0, dur: 0.12, type: 'sine', gain: 0.3 }
  ],
  alert: [
    { freq: 1000, at: 0, dur: 0.09, type: 'square', gain: 0.55 },
    { freq: 1000, at: 0.14, dur: 0.09, type: 'square', gain: 0.55 },
    { freq: 1000, at: 0.28, dur: 0.09, type: 'square', gain: 0.55 }
  ],
  buzz: [
    { freq: 170, at: 0, dur: 0.22, type: 'sawtooth', gain: 0.5 },
    { freq: 140, at: 0.26, dur: 0.26, type: 'sawtooth', gain: 0.5 }
  ]
};

export function isSoundId(id) {
  return Object.prototype.hasOwnProperty.call(VOICES, id);
}

export function resolveSoundId(id) {
  return isSoundId(id) ? id : DEFAULT_SOUND;
}

/** Total length of a preset in seconds. */
export function soundDuration(id) {
  const notes = VOICES[resolveSoundId(id)];
  return notes.reduce((max, n) => Math.max(max, n.at + n.dur), 0);
}

export function clampVolume(volume) {
  const n = Number(volume);
  if (!Number.isFinite(n)) return 0.3;
  return Math.min(1, Math.max(0, n));
}

/**
 * Schedule a preset into any BaseAudioContext. Returns when the last note ends,
 * expressed in that context's own time base.
 */
export function renderSound(ctx, id, volume, startAt = ctx.currentTime + 0.02) {
  const notes = VOICES[resolveSoundId(id)];
  const level = clampVolume(volume);
  if (level === 0) return startAt;

  const master = ctx.createGain();
  master.gain.value = 1;
  master.connect(ctx.destination);

  let end = startAt;
  for (const note of notes) {
    const osc = ctx.createOscillator();
    const env = ctx.createGain();
    osc.type = note.type;
    osc.frequency.value = note.freq;

    const t = startAt + note.at;
    const peak = Math.max(0.0001, level * (note.gain ?? 1));
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(peak, t + Math.min(0.02, note.dur / 4));
    env.gain.exponentialRampToValueAtTime(0.0001, t + note.dur);

    osc.connect(env);
    env.connect(master);
    osc.start(t);
    osc.stop(t + note.dur + 0.02);
    end = Math.max(end, t + note.dur);
  }
  return end;
}

let liveCtx = null;

/**
 * Play a preset through a live AudioContext. The context is resumed *before*
 * anything is scheduled: a suspended context has a frozen currentTime, so notes
 * scheduled against it land in the past and are never heard.
 */
export async function playSound(id, volume) {
  const Ctor = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (!Ctor) throw new Error('Web Audio is not available here');

  if (!liveCtx || liveCtx.state === 'closed') liveCtx = new Ctor();
  if (liveCtx.state === 'suspended') await liveCtx.resume();
  if (liveCtx.state !== 'running') {
    throw new Error(`audio context is ${liveCtx.state} (blocked by autoplay policy)`);
  }

  renderSound(liveCtx, id, volume);
  return true;
}
