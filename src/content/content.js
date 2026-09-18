/**
 * Content script: extracts readable text blocks, auto-scrolls to pull in more
 * content, and streams de-duplicated blocks to the service worker.
 *
 * Runs on every page but stays completely idle unless the service worker reports
 * that a capture session is active for this tab.
 */

(() => {
  if (window.__wordCloudAnalyzerInjected) return;
  window.__wordCloudAnalyzerInjected = true;

  const SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'SVG', 'CANVAS', 'IFRAME', 'TEXTAREA', 'INPUT', 'SELECT', 'CODE', 'PRE'
  ]);
  const BLOCK_SELECTOR = [
    '[data-testid="tweetText"]',
    'article',
    '[role="article"]',
    'p',
    'li',
    'blockquote',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'dd',
    'figcaption',
    'div[dir="auto"]',
    'div[lang]',
    '.content', '.post', '.comment', '.entry-content'
  ].join(',');

  let stopRequested = false;
  let running = false;

  /** 64-bit FNV-1a style hash rendered as hex; stable across page loads. */
  function hashText(str) {
    let h1 = 0x811c9dc5;
    let h2 = 0x01000193;
    for (let i = 0; i < str.length; i += 1) {
      const c = str.charCodeAt(i);
      h1 ^= c;
      h1 = Math.imul(h1, 0x01000193) >>> 0;
      h2 = (Math.imul(h2 ^ c, 0x85ebca6b) + i) >>> 0;
    }
    return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
  }

  /** Normalizes text so cosmetic differences do not defeat de-duplication. */
  function normalize(text) {
    return text
      .replace(/\s+/g, ' ')
      .replace(/[\u200b-\u200f\ufeff]/g, '')
      .trim()
      .toLowerCase();
  }

  function isVisible(el) {
    const rect = el.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return false;
    const style = window.getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0';
  }

  function isInChrome(el) {
    return Boolean(el.closest('nav, header, footer, aside, [role="navigation"], [role="banner"], [aria-hidden="true"]'));
  }

  /**
   * Collect innermost text blocks currently in the DOM.
   * @param {{minTextLength:number, maxTextLength:number}} settings
   */
  function extractBlocks(settings) {
    const candidates = Array.from(document.querySelectorAll(BLOCK_SELECTOR)).filter(
      (el) => !SKIP_TAGS.has(el.tagName)
    );
    const candidateSet = new Set(candidates);
    const hasNestedCandidate = new Set();

    for (const el of candidates) {
      let parent = el.parentElement;
      while (parent) {
        if (candidateSet.has(parent)) hasNestedCandidate.add(parent);
        parent = parent.parentElement;
      }
    }

    const seen = new Set();
    const blocks = [];
    for (const el of candidates) {
      if (hasNestedCandidate.has(el)) continue;
      if (isInChrome(el) || !isVisible(el)) continue;
      const raw = (el.innerText || el.textContent || '').trim();
      if (!raw) continue;
      const text = raw.length > settings.maxTextLength ? raw.slice(0, settings.maxTextLength) : raw;
      const normalized = normalize(text);
      if (normalized.replace(/[^\p{L}\p{N}]/gu, '').length < settings.minTextLength) continue;
      const hash = hashText(normalized);
      if (seen.has(hash)) continue;
      seen.add(hash);
      blocks.push({ hash, text: text.replace(/\s+/g, ' ').trim() });
    }
    return blocks;
  }

  /** Pick the element that actually scrolls: the document, or the biggest inner scroller. */
  function findScroller() {
    const doc = document.scrollingElement || document.documentElement;
    if (doc.scrollHeight > window.innerHeight + 50) return doc;
    let best = null;
    let bestArea = 0;
    for (const el of document.querySelectorAll('div, main, section, ul')) {
      const style = window.getComputedStyle(el);
      if (!/(auto|scroll)/.test(style.overflowY)) continue;
      if (el.scrollHeight <= el.clientHeight + 50) continue;
      const area = el.clientWidth * el.clientHeight;
      if (area > bestArea) {
        best = el;
        bestArea = area;
      }
    }
    return best || doc;
  }

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  /** Wait until the DOM stops mutating, or until maxWait elapses. */
  function waitForContent(maxWait) {
    return new Promise((resolve) => {
      let timer = null;
      const observer = new MutationObserver(() => {
        clearTimeout(timer);
        timer = setTimeout(finish, 350);
      });
      const finish = () => {
        observer.disconnect();
        clearTimeout(timer);
        clearTimeout(hardStop);
        resolve();
      };
      const hardStop = setTimeout(finish, maxWait);
      timer = setTimeout(finish, Math.min(500, maxWait));
      observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    });
  }

  function scrollStep(scroller) {
    const isDoc = scroller === document.scrollingElement || scroller === document.documentElement;
    const step = (isDoc ? window.innerHeight : scroller.clientHeight) * 0.85;
    if (isDoc) {
      window.scrollBy({ top: step, behavior: 'auto' });
      return window.scrollY;
    }
    scroller.scrollTop += step;
    return scroller.scrollTop;
  }

  function scrollPosition(scroller) {
    const isDoc = scroller === document.scrollingElement || scroller === document.documentElement;
    return isDoc ? window.scrollY : scroller.scrollTop;
  }

  /** True once the viewport sits at the very end of the scroller. */
  function atBottom(scroller) {
    const isDoc = scroller === document.scrollingElement || scroller === document.documentElement;
    const viewport = isDoc ? window.innerHeight : scroller.clientHeight;
    return scrollPosition(scroller) + viewport >= scroller.scrollHeight - 4;
  }

  async function send(message) {
    try {
      return await chrome.runtime.sendMessage(message);
    } catch (err) {
      return null;
    }
  }

  async function runCycle(settings) {
    if (running) return;
    running = true;
    stopRequested = false;

    const startedAt = Date.now();
    const host = location.host;
    const cycleSeen = new Set();
    const stats = { rounds: 0, sent: 0, added: 0, duplicates: 0, stopReason: 'completed' };
    const scroller = findScroller();
    let idleRounds = 0;
    let travelIdleRounds = 0;
    const maxTravelIdleRounds = Math.max(3, settings.idleRoundsToStop * 3);
    let lastPosition = -1;
    let lastHeight = -1;

    try {
      for (let round = 0; round < settings.maxScrolls; round += 1) {
        if (stopRequested) {
          stats.stopReason = 'stopped';
          break;
        }
        if (Date.now() - startedAt > settings.cycleTimeoutMs) {
          stats.stopReason = 'timeout';
          break;
        }

        stats.rounds = round + 1;
        const blocks = extractBlocks(settings).filter((b) => !cycleSeen.has(b.hash));
        blocks.forEach((b) => cycleSeen.add(b.hash));

        let roundAdded = 0;
        if (blocks.length) {
          const ts = Date.now();
          const response = await send({
            type: 'CAPTURE',
            host,
            url: location.href,
            title: document.title,
            ts,
            items: blocks
          });
          stats.sent += blocks.length;
          roundAdded = response?.added ?? 0;
          stats.added += roundAdded;
          stats.duplicates += response?.duplicates ?? 0;
        }

        const newRatio = blocks.length ? roundAdded / blocks.length : 0;
        const position = scrollPosition(scroller);
        const height = scroller.scrollHeight;
        const stuck = position === lastPosition && height === lastHeight;

        // "Seen it all" heuristics: nothing extractable, everything already stored
        // (we scrolled back into content captured before the refresh), or the page
        // simply stopped growing and we cannot scroll any further.
        const nothingNew = blocks.length === 0;
        const duplicateHeavy = blocks.length > 0 && newRatio <= 1 - settings.duplicateStopRatio;
        // While we are still travelling down a long page, "nothing new" only means
        // this screenful was already captured - infinite feeds usually append their
        // next page only once the viewport actually reaches the bottom.
        const travelling = !stuck && !atBottom(scroller);
        if (duplicateHeavy || stuck || (nothingNew && !travelling)) idleRounds += 1;
        else idleRounds = 0;
        // ... but do not keep travelling for ever through content we already have.
        if (nothingNew || duplicateHeavy) travelIdleRounds += 1;
        else travelIdleRounds = 0;

        if (idleRounds >= settings.idleRoundsToStop || travelIdleRounds >= maxTravelIdleRounds) {
          stats.stopReason = duplicateHeavy ? 'reached-known-content' : stuck ? 'end-of-page' : 'no-new-content';
          break;
        }

        lastPosition = position;
        lastHeight = height;

        await send({ type: 'PROGRESS', stats: { ...stats }, url: location.href });

        scrollStep(scroller);
        await sleep(settings.scrollDelayMs);
        await waitForContent(Math.max(1200, settings.scrollDelayMs * 2));
      }
      if (stats.rounds >= settings.maxScrolls && stats.stopReason === 'completed') {
        stats.stopReason = 'max-scrolls';
      }
    } catch (err) {
      stats.stopReason = `error: ${err?.message || err}`;
    } finally {
      running = false;
      await send({ type: 'CYCLE_DONE', stats, host, url: location.href });
    }
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'STOP_CYCLE') {
      stopRequested = true;
      sendResponse({ ok: true });
      return true;
    }
    if (msg?.type === 'START_CYCLE') {
      sendResponse({ ok: true, alreadyRunning: running });
      if (!running) runCycle(msg.settings);
      return true;
    }
    if (msg?.type === 'PING') {
      sendResponse({ ok: true, running, url: location.href });
      return true;
    }
    return false;
  });

  // Announce ourselves after (re)load; the worker replies if this tab is capturing.
  (async () => {
    const response = await send({ type: 'CONTENT_READY', url: location.href, host: location.host });
    if (response?.active && response.settings) {
      await sleep(1200); // let the freshly loaded page settle
      runCycle(response.settings);
    }
  })();
})();
