# Multi-lingual Dynamic Word Cloud Analyzer

A dependency-free Chrome extension (Manifest V3) that reads high-volume timelines such as
**x.com** or **weibo.com**, understands **English and 中文**, keeps scrolling and refreshing
on its own, remembers what it has already seen, and turns the last 30 minutes / 7 days of
content into comparable word clouds.

Nothing leaves the browser: all text stays in a local IndexedDB database.

---

## Install

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and pick this folder (`chrome-helper`).
4. Pin the extension so the popup is one click away.

There is no build step and no external library to download.

## Use it

1. Open the site you want to follow (e.g. `https://x.com/home`).
2. Click the extension icon → **Start capturing**.
   * The page scrolls itself to the bottom, waiting for lazily loaded posts after every step.
   * A cycle stops as soon as it reaches the end of the feed or runs back into content that
     was already stored (so a refresh does not re-ingest the whole timeline).
   * The badge shows how many tabs are capturing.
3. With **Auto-refresh** enabled the extension reloads the tab every *n* minutes and captures
   only what is new.
4. Click **Cloud · last 30 min**, **24 h** or **7 days** to open the dashboard.

> Keep the capturing tab visible if you want maximum speed. Chrome heavily throttles timers in
> hidden tabs, so a background tab will still capture, just more slowly.

## Dashboard

* **Word cloud** for the selected window, sized by how many posts contain a word.
* **Compare with** a previous equal period, the last 24 h or the last 7 days — the
  **Trending** tab lists what is rising and falling.
* **Top words** table (posts / total uses), **Posts** tab with representative blocks,
  **Export CSV**, and click-through from a word to the posts that contain it.
* Filters for site (host), time window, and language (All / 中文 / English).

## Settings

Open **Settings** from the popup (or `chrome://extensions` → *Details* → *Extension options*).

| Group | What you can tune |
| --- | --- |
| Capture & auto-scroll | auto-refresh + interval, max scroll rounds, pause between scrolls, idle rounds before stopping, duplicate ratio that means "already seen", cycle timeout, min/max characters per block |
| Analysis | retention days (default 7), short window (default 30 min), long window (default 7 days), weighting (posts vs occurrences), minimum count, max words, single Chinese characters, phrases, #hashtags, @mentions, extra stop words (English or 中文) |
| Long words | length threshold, hide from cloud, audio alert, alert volume |
| Stored data | how much is stored, prune now, delete everything |

Old content is pruned automatically once per hour using the retention setting.

### Long words

| Setting | Default | Meaning |
| --- | --- | --- |
| Longer than (characters) | `15` | A word counts as long when its length is **strictly greater** than this. `0` switches both the hiding and the alert off. |
| Hide these words from the cloud | off | Long words are dropped from both clouds. Useful for sites that emit run-together identifiers or tracking blobs. |
| Play a sound when a new one is captured | off | The chosen sound rings the first time a long word is captured. |
| Alert sound | `chime` | Chime, Ping, Bell, Marimba, Alert or Buzz. Picking one previews it immediately. |
| Alert volume | `0.3` | `0`–`1`; `0` is silent. The **Test sound** button plays the sound right away. |

Notes:

- Only **single unbroken words** count — English tokens, `#hashtags`, and segmented 中文 terms. Multi-word phrases such as *investors dump technology stocks* are never counted, even though they are far longer than 15 characters.
- Detection runs the full analyzer over the newly captured blocks, so the alert can only fire for a word the cloud would actually show. It never fires on a whole unsegmented Chinese sentence or on a URL.
- Each distinct word rings **at most once per 24 hours**; announced words are remembered in the `meta` store and expire after a day. *Delete everything* also resets that list.
- The last five detected long words are listed in the popup.
- Chinese terms are capped at 8 characters by the segmenter, so a threshold of 15 will in practice only ever fire for English words and hashtags. If you mainly read 中文, set the threshold to around **6–7**.
- MV3 service workers have no DOM, so sounds are played from an offscreen document (`src/offscreen/`) and synthesised with Web Audio in `src/lib/sounds.js` — no audio file ships with the extension. This needs the `offscreen` permission and Chrome 116+.
- **Test sound** plays the sound in the options page itself (a real user gesture, so it always works) *and* exercises the background path a real alert uses. If the background path is broken it prints the reason under the panel, e.g. `Background alerts are not working: …`.

## How it works

```
content script  →  service worker  →  IndexedDB  →  dashboard
 extract+scroll     sessions/alarms     dedup+TTL     analyze+render
```

* **Extraction** (`src/content/content.js`) picks the innermost text blocks of the page
  (posts, list items, paragraphs), skipping navigation/header/footer chrome.
* **Deduplication**: every block is normalised (whitespace collapsed, zero-width characters
  removed) and hashed; the database key is `host|hash`. A refresh therefore reports
  `added: 0, duplicates: N` for content already captured — that is exactly the signal the
  scroller uses to decide it has reached known content and can stop.
* **Timestamps**: each stored block carries the capture time, which is what makes the
  30-minute / 7-day windows and the trending comparison possible.
* **Auto-refresh** is driven by `chrome.alarms` in the service worker, so it survives the
  worker being suspended.

### Bilingual analysis (`src/lib/tokenize.js`)

No dictionary and no third-party segmenter — everything runs offline:

* **English**: tokenised, stop words removed, plurals folded (`posts` → `post`), and 2–3 word
  phrases kept when they genuinely co-occur. Runs are broken at punctuation and at CJK text,
  so a phrase never spans a comma or two languages.
* **中文**: text is split into runs at function characters and multi-character stop words,
  then 2–4-gram candidates are counted and filtered by
  * *cohesion* (a PMI-like score, killing accidental cross-word pairs), and
  * *subsumption* (a shorter gram is dropped when a longer one explains it), so
    人工智能 survives instead of 人工智 or 智能.
* **Phrase growth**: because n-grams are capped at 4 (中文) / 3 (English), longer phrases such as
  火箭发射成功 appear only as overlapping max-length grams. These are chained back together in
  both directions, and a phrase that starts in the middle of a more popular one gets its shared
  head trimmed (so you see 引发科技股, not 管新规引发科技股).

## Tests

Everything is verified in a real browser (there is no Node.js dependency). Serve the folder
and open the harnesses:

```powershell
python -m http.server 8777    # run from the project root
```

| URL | What it covers |
| --- | --- |
| `http://127.0.0.1:8777/test/browser.html` | 31 checks: tokenizer/analyzer (EN + 中文), long-word detection, alert-sound rendering, IndexedDB dedup/windows/pruning, word-cloud layout |
| `http://127.0.0.1:8777/test/capture.html` | 8 checks: the real content script against a mock infinite feed — full lazy-load capture, refresh with only-new storage, duplicate detection, stop request |
| `http://127.0.0.1:8777/test/worker.html` | 26 checks: the real service worker — session lifecycle, badge, dedup counters, refresh alarms, long-word alerts, pruning, cleanup |
| `http://127.0.0.1:8777/test/seed.html` | seeds 190 realistic bilingual blocks across 7 days so the dashboard can be reviewed with data |

Keep the harness tab focused while it runs: hidden tabs are timer-throttled by Chrome and the
capture harness will crawl.

## Layout

```
manifest.json
src/
  background.js          service worker: sessions, alarms, refresh, pruning
  content/content.js     extraction + auto-scroll engine
  lib/db.js              IndexedDB store, dedup, time-window queries
  lib/tokenize.js        bilingual analyzer and comparison
  lib/stopwords.js       English / Chinese stop data
  lib/settings.js        defaults + storage helpers
  lib/wordcloud.js       canvas word-cloud renderer
  lib/sounds.js          synthesised alert sounds (shared by options + offscreen)
  offscreen/             Web Audio chime for long-word alerts (MV3 offscreen document)
  popup/ options/ dashboard/
test/                    browser test harnesses
```

## Permissions

`storage`, `unlimitedStorage` (local history), `tabs`, `scripting`, `alarms` (scheduled
refresh), `offscreen` (the long-word chime) and `<all_urls>` (the extension must read the
page you point it at). No network requests are made by the extension itself.
