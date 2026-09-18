/**
 * Bilingual (English + Chinese) tokenizer and term ranker.
 *
 * English: content-word tokens plus adjacent-word phrases.
 * Chinese: dictionary-free segmentation. Text is split on punctuation and common
 * particles, then 2- to 4-character n-grams are scored with a cohesion (PMI-like)
 * test and an "is this only a fragment of a longer phrase?" test, so that real
 * words such as 人工智能 survive while accidental cross-boundary pairs do not.
 */

import { EN_STOPWORDS, ZH_STOPWORDS, ZH_SPLIT_CHARS, ZH_BOUNDARY_CHARS } from './stopwords.js';

const CJK = '\\u4e00-\\u9fff\\u3400-\\u4dbf\\uf900-\\ufaff';
const CJK_RE = new RegExp(`[${CJK}]`);
const CJK_RUN_RE = new RegExp(`[${CJK}]+`, 'g');
const CJK_GLOBAL_RE = new RegExp(`[${CJK}]`, 'g');
const LATIN_TOKEN_RE = /[a-z][a-z0-9'’]*(?:[-_][a-z0-9'’]+)*/g;
const URL_RE = /\bhttps?:\/\/\S+|\bwww\.\S+/gi;
// Capture the whole tag/handle: a bounded quantifier would silently truncate a
// long one into a mangled token instead of taking it as a whole.
const HASHTAG_RE = /[#＃]([\w\u4e00-\u9fff]+)/g;
const MENTION_RE = /@([A-Za-z0-9_]{2,})/g;
const MAX_TAG_LENGTH = 100;

export const DEFAULTS = {
  minCount: 1,
  maxTerms: 180,
  weightBy: 'docFreq', // 'docFreq' | 'count'
  includeSingleChars: false,
  includePhrases: true,
  includeHashtags: true,
  includeMentions: false,
  minCohesion: 1.5,
  minPhraseCount: 2,
  subsumeRatio: 0.7,
  growPhrases: true,
  chainRatio: 0.85,
  maxGramZh: 4,
  maxGramEn: 3,
  maxWordChars: 0, // >0 hides single words (no spaces) longer than this
  extraStopwords: []
};

/** A term is a "single word" when it contains no whitespace (中文 terms never do). */
export function isSingleWord(text) {
  return !/\s/.test(text);
}

/** Rough language tag for a piece of text. */
export function detectLang(text) {
  const cjk = (text.match(CJK_GLOBAL_RE) || []).length;
  const latin = (text.match(/[A-Za-z]/g) || []).length;
  if (cjk === 0 && latin === 0) return 'other';
  const total = cjk + latin;
  if (cjk / total > 0.15 && latin / total > 0.15) return 'mixed';
  return cjk >= latin ? 'zh' : 'en';
}

function stripNoise(text) {
  return text.replace(URL_RE, ' ');
}

/** Ordered English tokens for one document; stop words are kept but flagged. */
function englishTokens(text) {
  const out = [];
  const lower = text.toLowerCase();
  let m;
  LATIN_TOKEN_RE.lastIndex = 0;
  while ((m = LATIN_TOKEN_RE.exec(lower)) !== null) {
    const w = m[0].replace(/['’]s$/, '').replace(/^[-_']+|[-_']+$/g, '');
    if (w.length < 2) continue;
    out.push({ w, stop: EN_STOPWORDS.has(w) });
  }
  return out;
}

/**
 * Split an English token stream into runs of consecutive content words.
 * Chinese text and punctuation also break a run, so words on either side of 中文
 * or a comma are never glued into a bogus phrase.
 */
function englishRuns(text, extraStops) {
  const runs = [];
  for (const chunk of text.split(CJK_RUN_RE)) {
    for (const piece of chunk.split(/[^\p{L}\p{N}'’\-_ \t]+/u)) {
      let current = [];
      for (const t of englishTokens(piece)) {
        if (t.stop || extraStops.has(t.w) || /^\d+$/.test(t.w)) {
          if (current.length) runs.push(current);
          current = [];
        } else {
          current.push(t.w);
        }
      }
      if (current.length) runs.push(current);
    }
  }
  return runs;
}

/**
 * Cut Chinese text into candidate word segments: multi-character function words
 * are removed first, then remaining runs are split at function characters.
 */
function chineseSegments(text, extraZhStops = []) {
  let prepared = text;
  for (const stop of ZH_STOPWORDS) {
    if (prepared.includes(stop)) prepared = prepared.split(stop).join('\u0000');
  }
  for (const stop of extraZhStops) prepared = prepared.split(stop).join('\u0000');
  const segments = [];
  const runs = prepared.match(CJK_RUN_RE) || [];
  for (const run of runs) {
    let current = '';
    for (const ch of run) {
      if (ZH_SPLIT_CHARS.has(ch)) {
        if (current) segments.push(current);
        current = '';
      } else {
        current += ch;
      }
    }
    if (current) segments.push(current);
  }
  return segments;
}

function validZhGram(gram) {
  if (ZH_BOUNDARY_CHARS.has(gram[0]) || ZH_BOUNDARY_CHARS.has(gram[gram.length - 1])) return false;
  return !ZH_STOPWORDS.has(gram);
}

class TermTable {
  constructor() {
    this.map = new Map();
  }

  bump(text, lang, docIndex, sample) {
    let entry = this.map.get(text);
    if (!entry) {
      entry = { text, lang, count: 0, docFreq: 0, samples: [], _lastDoc: -1 };
      this.map.set(text, entry);
    }
    entry.count += 1;
    if (entry._lastDoc !== docIndex) {
      entry._lastDoc = docIndex;
      entry.docFreq += 1;
      if (entry.samples.length < 3 && sample) entry.samples.push(sample);
    }
    return entry;
  }

  get(text) {
    return this.map.get(text);
  }
}

function bumpCount(map, key) {
  map.set(key, (map.get(key) || 0) + 1);
}

function raiseMax(map, key, value) {
  if ((map.get(key) || 0) < value) map.set(key, value);
}

const splitZh = (gram) => [gram.slice(0, -1), gram.slice(1)];
const splitEn = (phrase) => {
  const words = phrase.split(' ');
  return [words.slice(0, -1).join(' '), words.slice(1).join(' ')];
};

/**
 * Decide which n-grams to keep, walking from the longest to the shortest.
 *
 * A gram is dropped when a longer, nearly-as-frequent gram contains it (it is only
 * a fragment, e.g. 人工智 inside 人工智能), or when it fails the quality test for its
 * length. Rejected grams do not shadow their fragments, so a phrase that is too rare
 * to display never hides the individual words it is made of.
 *
 * @param {Map<string, number>} counts gram -> corpus count
 * @param {(gram:string)=>number} lengthOf number of units in a gram
 * @param {(gram:string)=>string[]} split the two (n-1)-unit sub-grams
 * @param {(gram:string, count:number, n:number)=>boolean} isQuality
 * @param {number} subsumeRatio
 * @returns {Set<string>} grams to drop
 */
function selectGrams(counts, lengthOf, split, isQuality, subsumeRatio) {
  const byLength = new Map();
  let maxLength = 1;
  for (const [gram] of counts) {
    const n = lengthOf(gram);
    maxLength = Math.max(maxLength, n);
    if (!byLength.has(n)) byLength.set(n, []);
    byLength.get(n).push(gram);
  }

  const drop = new Set();
  const support = new Map(); // gram -> count of the longer gram that swallows it

  for (let n = maxLength; n >= 1; n -= 1) {
    for (const gram of byLength.get(n) || []) {
      const count = counts.get(gram);
      const swallowedBy = support.get(gram) || 0;
      const isFragment = swallowedBy >= subsumeRatio * count;
      const keep = !isFragment && isQuality(gram, count, n);
      if (!keep) drop.add(gram);

      // Only a surviving (or already-swallowed) gram may shadow its sub-grams.
      const propagate = isFragment ? swallowedBy : keep ? count : 0;
      if (propagate && n > 1) {
        for (const sub of split(gram)) {
          if (counts.has(sub)) raiseMax(support, sub, propagate);
        }
      }
    }
  }
  return drop;
}

/**
 * Rebuild phrases that are longer than the n-gram limit.
 *
 * 火箭发射成功 can only be seen as the overlapping 4-grams 火箭发射 / 箭发射成 /
 * 发射成功. When such grams have near-identical counts they are chained back into
 * the full phrase and the fragments are dropped.
 *
 * @param {TermTable} terms
 * @param {Set<string>} drop
 * @param {{unitsOf:Function, join:Function, gramLength:number, maxUnits:number, langs:string[], ratio:number}} cfg
 */
function growPhrases(terms, drop, cfg) {
  const { unitsOf, join, gramLength, maxUnits, langs, ratio } = cfg;
  const candidates = [...terms.map.values()].filter(
    (e) => langs.includes(e.lang) && !drop.has(e.text) && unitsOf(e.text).length === gramLength
  );
  if (candidates.length < 2) return;

  const byPrefix = new Map();
  const bySuffix = new Map();
  for (const entry of candidates) {
    const units = unitsOf(entry.text);
    const prefix = join(units.slice(0, gramLength - 1));
    const suffix = join(units.slice(1));
    if (!byPrefix.has(prefix)) byPrefix.set(prefix, []);
    byPrefix.get(prefix).push(entry);
    if (!bySuffix.has(suffix)) bySuffix.set(suffix, []);
    bySuffix.get(suffix).push(entry);
  }

  const consumed = new Set();
  const produced = [];
  const similar = (a, b) => Math.min(a, b) >= ratio * Math.max(a, b);

  for (const start of [...candidates].sort((a, b) => b.count - a.count)) {
    if (consumed.has(start.text)) continue;
    let units = unitsOf(start.text);
    let count = start.count;
    let docFreq = start.docFreq;
    const chain = [start];
    const pick = (bucket) =>
      (bucket || []).find((e) => !consumed.has(e.text) && !chain.includes(e) && similar(e.count, count));

    // Grow in both directions so the result does not depend on where we started.
    let grew = true;
    while (grew && units.length < maxUnits) {
      grew = false;
      const next = pick(byPrefix.get(join(units.slice(units.length - (gramLength - 1)))));
      if (next) {
        units = units.concat(unitsOf(next.text).slice(gramLength - 1));
        count = Math.min(count, next.count);
        docFreq = Math.min(docFreq, next.docFreq);
        chain.push(next);
        grew = true;
      }
      if (units.length >= maxUnits) break;
      const prev = pick(bySuffix.get(join(units.slice(0, gramLength - 1))));
      if (prev) {
        units = unitsOf(prev.text).slice(0, 1).concat(units);
        count = Math.min(count, prev.count);
        docFreq = Math.min(docFreq, prev.docFreq);
        chain.push(prev);
        grew = true;
      }
    }

    if (chain.length < 2) continue;
    const text = join(units);
    for (const member of chain) {
      consumed.add(member.text);
      drop.add(member.text);
    }
    const merged = terms.bump(text, start.lang, -1, null);
    merged.count = count;
    merged.docFreq = docFreq;
    merged.samples = start.samples;
    drop.delete(text);
    produced.push({ entry: merged, units, lang: start.lang });
  }

  // Plain n-grams can start mid-phrase too, so they take part in the clean-up.
  const extra = [...terms.map.values()]
    .filter(
      (e) =>
        langs.includes(e.lang) &&
        !drop.has(e.text) &&
        unitsOf(e.text).length >= gramLength &&
        !produced.some((p) => p.entry === e)
    )
    .map((e) => ({ entry: e, units: unitsOf(e.text), lang: e.lang }));

  trimOverlappingHeads(produced.concat(extra), terms, drop, cfg);
}
/**
 * A rarer phrase may start in the middle of a more popular one
 * ("intelligence regulation lands today" next to "artificial intelligence
 * regulation"). Cut the shared head off so every phrase starts at a word
 * boundary the reader recognises, and drop what is left if it is too short.
 */
function trimOverlappingHeads(produced, terms, drop, cfg) {
  const { join, gramLength } = cfg;
  const spaced = join(['a', 'b']) === 'a b';
  const covers = (haystack, needle) =>
    spaced ? ` ${haystack} `.includes(` ${needle} `) : haystack.includes(needle);

  const kept = [];
  const rivals = (minCount, selfText) =>
    [...terms.map.values()]
      .filter((e) => e.text !== selfText && !drop.has(e.text) && e.count > minCount)
      .map((e) => e.text);

  for (const item of [...produced].sort((a, b) => b.entry.count - a.entry.count)) {
    let units = item.units;
    const pool = rivals(item.entry.count, item.entry.text).concat(kept);
    for (let k = units.length - 1; k >= gramLength - 1; k -= 1) {
      const head = join(units.slice(0, k));
      if (pool.some((text) => covers(text, head))) {
        units = units.slice(k);
        break;
      }
    }
    if (units.length === item.units.length) {
      kept.push(item.entry.text);
      continue;
    }
    drop.add(item.entry.text);
    if (units.length < 2) continue;
    const text = join(units);
    const moved = terms.bump(text, item.lang, -1, null);
    moved.count = Math.max(moved.count, item.entry.count);
    moved.docFreq = Math.max(moved.docFreq, item.entry.docFreq);
    moved.samples = item.entry.samples;
    drop.delete(text);
    kept.push(text);
  }
}

/**
 * Rank terms across a set of captured documents.
 * @param {Array<{text:string, ts?:number, lang?:string}>} docs
 * @param {Partial<typeof DEFAULTS>} [options]
 */
export function analyze(docs, options = {}) {
  const opt = { ...DEFAULTS, ...options };
  const extraStops = new Set((opt.extraStopwords || []).map((s) => String(s).trim().toLowerCase()).filter(Boolean));
  const extraZhStops = [...extraStops].filter((s) => CJK_RE.test(s));

  const terms = new TermTable();
  const zhCounts = new Map(); // Chinese n-gram (n >= 2) -> corpus count
  const enCounts = new Map(); // English phrase (1..maxGramEn words) -> corpus count
  const zhCharCount = new Map();
  let totalZhChars = 0;
  let totalEnWords = 0;
  const langMix = { zh: 0, en: 0, mixed: 0, other: 0 };

  docs.forEach((doc, index) => {
    const raw = doc.text || '';
    const lang = doc.lang || detectLang(raw);
    langMix[lang] = (langMix[lang] || 0) + 1;
    const cleaned = stripNoise(raw);
    const sample = raw.slice(0, 240);

    if (opt.includeHashtags) {
      HASHTAG_RE.lastIndex = 0;
      let m;
      while ((m = HASHTAG_RE.exec(cleaned)) !== null) {
        if (m[1].length > MAX_TAG_LENGTH) continue;
        terms.bump(`#${m[1].toLowerCase()}`, 'tag', index, sample);
      }
    }
    if (opt.includeMentions) {
      MENTION_RE.lastIndex = 0;
      let m;
      while ((m = MENTION_RE.exec(cleaned)) !== null) {
        if (m[1].length > MAX_TAG_LENGTH) continue;
        terms.bump(`@${m[1].toLowerCase()}`, 'tag', index, sample);
      }
    }

    const maxEn = opt.includePhrases ? opt.maxGramEn : 1;
    for (const run of englishRuns(cleaned, extraStops)) {
      totalEnWords += run.length;
      for (let n = 1; n <= Math.min(maxEn, run.length); n += 1) {
        for (let i = 0; i + n <= run.length; i += 1) {
          const phrase = run.slice(i, i + n).join(' ');
          bumpCount(enCounts, phrase);
          terms.bump(phrase, n === 1 ? 'en' : 'en-phrase', index, sample);
        }
      }
    }

    if (!CJK_RE.test(cleaned)) return;
    for (const seg of chineseSegments(cleaned, extraZhStops)) {
      for (const ch of seg) {
        bumpCount(zhCharCount, ch);
        totalZhChars += 1;
      }
      if (seg.length === 1) {
        if (opt.includeSingleChars && !extraStops.has(seg)) terms.bump(seg, 'zh', index, sample);
        continue;
      }
      for (let n = 2; n <= Math.min(opt.maxGramZh, seg.length); n += 1) {
        for (let i = 0; i + n <= seg.length; i += 1) {
          const gram = seg.slice(i, i + n);
          if (!validZhGram(gram) || extraStops.has(gram)) continue;
          bumpCount(zhCounts, gram);
          terms.bump(gram, n === 2 ? 'zh' : 'zh-phrase', index, sample);
        }
      }
    }
  });

  const zhDrop = selectGrams(
    zhCounts,
    (gram) => gram.length,
    splitZh,
    (gram, count, n) => {
      if (n === 2) {
        const a = zhCharCount.get(gram[0]) || 1;
        const b = zhCharCount.get(gram[1]) || 1;
        return (count * totalZhChars) / (a * b) >= opt.minCohesion;
      }
      return count >= opt.minPhraseCount;
    },
    opt.subsumeRatio
  );

  const enDrop = selectGrams(
    enCounts,
    (phrase) => phrase.split(' ').length,
    splitEn,
    (phrase, count, n) => {
      if (n === 1) return true;
      if (count < opt.minPhraseCount) return false;
      if (n > 2) return true;
      const words = phrase.split(' ');
      const ca = enCounts.get(words[0]) || 1;
      const cb = enCounts.get(words[1]) || 1;
      return (count * totalEnWords) / (ca * cb) >= opt.minCohesion;
    },
    opt.subsumeRatio
  );

  const drop = new Set([...zhDrop, ...enDrop]);

  if (opt.growPhrases) {
    growPhrases(terms, drop, {
      unitsOf: (text) => [...text],
      join: (units) => units.join(''),
      gramLength: opt.maxGramZh,
      maxUnits: opt.maxGramZh * 2,
      langs: ['zh', 'zh-phrase'],
      ratio: opt.chainRatio
    });
    if (opt.includePhrases) {
      growPhrases(terms, drop, {
        unitsOf: (text) => text.split(' '),
        join: (units) => units.join(' '),
        gramLength: opt.maxGramEn,
        maxUnits: opt.maxGramEn * 2,
        langs: ['en-phrase'],
        ratio: opt.chainRatio
      });
    }
  }

  mergeEnglishPlurals(terms, drop);

  const weightKey = opt.weightBy === 'count' ? 'count' : 'docFreq';
  const list = [];
  for (const entry of terms.map.values()) {
    if (drop.has(entry.text) || entry.count < opt.minCount) continue;
    if (opt.maxWordChars > 0 && isSingleWord(entry.text) && entry.text.length > opt.maxWordChars) continue;
    list.push({
      text: entry.text,
      lang: entry.lang,
      count: entry.count,
      docFreq: entry.docFreq,
      weight: entry[weightKey],
      samples: entry.samples
    });
  }
  list.sort((a, b) => b.weight - a.weight || b.count - a.count || a.text.localeCompare(b.text));

  return {
    terms: list.slice(0, opt.maxTerms),
    allTerms: list,
    docCount: docs.length,
    langMix
  };
}

/**
 * Find single words (no spaces) longer than `minChars` in a set of documents.
 * Runs the normal analyzer first, so what is reported matches what the cloud
 * would show: real English tokens, hashtags and segmented 中文 terms - never a
 * whole unsegmented Chinese sentence or a URL.
 * @param {Array<{text:string, ts?:number, lang?:string}>} docs
 * @param {number} minChars words must be strictly longer than this
 * @param {Partial<typeof DEFAULTS>} [options]
 */
export function findLongWords(docs, minChars, options = {}) {
  if (!docs?.length || !minChars || minChars < 2) return [];
  const { allTerms } = analyze(docs, {
    ...options,
    minCount: 1,
    maxTerms: Number.MAX_SAFE_INTEGER,
    maxWordChars: 0
  });
  return allTerms.filter((t) => isSingleWord(t.text) && t.text.length > minChars);
}

/** Fold "posts" into "post" when both forms were seen. */
function mergeEnglishPlurals(terms, drop) {
  for (const entry of terms.map.values()) {
    if (entry.lang !== 'en' || drop.has(entry.text)) continue;
    const w = entry.text;
    let singular = null;
    if (w.endsWith('ies') && w.length > 4) singular = `${w.slice(0, -3)}y`;
    else if (/(s|x|z|ch|sh)es$/.test(w) && w.length > 4) singular = w.slice(0, -2);
    else if (w.endsWith('s') && !w.endsWith('ss') && w.length > 3) singular = w.slice(0, -1);
    if (!singular) continue;
    const base = terms.get(singular);
    if (!base || drop.has(singular)) continue;
    base.count += entry.count;
    base.docFreq += entry.docFreq;
    if (base.samples.length < 3) base.samples.push(...entry.samples.slice(0, 3 - base.samples.length));
    drop.add(w);
  }
}

/**
 * Compare two analyses and report how terms moved between the windows.
 * @returns {Array<{text:string, lang:string, current:number, previous:number, delta:number, ratio:number}>}
 */
export function compareTerms(currentTerms, previousTerms) {
  const prev = new Map(previousTerms.map((t) => [t.text, t.weight]));
  const seen = new Set();
  const rows = [];
  for (const t of currentTerms) {
    const previous = prev.get(t.text) || 0;
    seen.add(t.text);
    rows.push({
      text: t.text,
      lang: t.lang,
      current: t.weight,
      previous,
      delta: t.weight - previous,
      ratio: (t.weight + 1) / (previous + 1)
    });
  }
  for (const t of previousTerms) {
    if (seen.has(t.text)) continue;
    rows.push({
      text: t.text,
      lang: t.lang,
      current: 0,
      previous: t.weight,
      delta: -t.weight,
      ratio: 1 / (t.weight + 1)
    });
  }
  rows.sort((a, b) => b.delta - a.delta || b.ratio - a.ratio);
  return rows;
}
