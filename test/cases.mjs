/**
 * Shared test cases for the analyzer. Runnable from Node (`node --test test/`)
 * and from the browser harness (test/browser.html).
 *
 * Each case receives a tiny assertion object so it does not depend on a runner.
 */

import { analyze, compareTerms, detectLang, findLongWords } from '../src/lib/tokenize.js';
import { SOUND_PRESETS, renderSound, soundDuration, resolveSoundId, clampVolume } from '../src/lib/sounds.js';

const docs = (texts) => texts.map((text, i) => ({ text, ts: 1000 + i }));

export const cases = [
  {
    name: 'detectLang distinguishes English, Chinese and mixed text',
    run(t) {
      t.equal(detectLang('Breaking news from the market today'), 'en');
      t.equal(detectLang('今天市场行情非常火爆'), 'zh');
      t.equal(detectLang('OpenAI 发布了新的模型 GPT'), 'mixed');
      t.equal(detectLang('123 !!! ???'), 'other');
    }
  },
  {
    name: 'English stop words are removed and content words ranked',
    run(t) {
      const result = analyze(
        docs([
          'The market is up today and the market looks strong',
          'Market volatility is the talk of the town',
          'Investors watch the market closely'
        ]),
        { minCount: 1, minPhraseCount: 99 }
      );
      const words = result.terms.map((x) => x.text);
      t.ok(words.includes('market'), 'market should be ranked');
      t.ok(!words.includes('the'), '"the" must be filtered');
      t.ok(!words.includes('is'), '"is" must be filtered');
      t.equal(result.terms.find((x) => x.text === 'market').docFreq, 3);
    }
  },
  {
    name: 'English plurals fold into the singular form',
    run(t) {
      const result = analyze(docs(['New post published', 'Three posts published', 'Another post here']), {
        minPhraseCount: 99
      });
      const post = result.terms.find((x) => x.text === 'post');
      t.ok(post, 'singular form should survive');
      t.equal(post.docFreq, 3);
      t.ok(!result.terms.some((x) => x.text === 'posts'), 'plural should be merged away');
    }
  },
  {
    name: 'English phrases beat their component words when they always co-occur',
    run(t) {
      const result = analyze(
        docs([
          'artificial intelligence is changing research',
          'artificial intelligence startups raise money',
          'everyone talks about artificial intelligence',
          'artificial intelligence regulation debated'
        ])
      );
      const words = result.terms.map((x) => x.text);
      t.ok(words.includes('artificial intelligence'), 'phrase should be kept');
      t.ok(!words.includes('artificial'), 'fragment should be dropped');
    }
  },
  {
    name: 'Chinese four-character words survive n-gram subsumption',
    run(t) {
      const result = analyze(
        docs(['人工智能正在改变世界', '很多公司投资人工智能技术', '人工智能的发展速度很快', '监管机构讨论人工智能风险'])
      );
      const words = result.terms.map((x) => x.text);
      t.ok(words.includes('人工智能'), `expected 人工智能, got ${words.slice(0, 8).join(',')}`);
      t.ok(!words.includes('人工智'), '3-char fragment should be dropped');
      t.ok(!words.includes('人工'), '2-char fragment should be dropped');
    }
  },
  {
    name: 'Chinese particles never start or end a term',
    run(t) {
      const result = analyze(
        docs(['他说这个市场的行情很好', '市场的行情继续走高', '大家都说市场行情不错', '行情市场今天很好'])
      );
      for (const term of result.terms) {
        t.ok(!term.text.startsWith('的'), `${term.text} starts with 的`);
        t.ok(!term.text.endsWith('的'), `${term.text} ends with 的`);
      }
      t.ok(
        result.terms.some((x) => x.text.includes('行情') || x.text.includes('市场')),
        'topic words should be found'
      );
    }
  },
  {
    name: 'mixed-language documents produce both English and Chinese terms',
    run(t) {
      const result = analyze(
        docs([
          'OpenAI 发布 GPT 模型，人工智能 竞争加剧',
          'Google 也在人工智能领域发力，openai 紧随其后',
          '人工智能 模型 openai 的能力提升',
          'openai 模型人工智能持续进化'
        ]),
        { minCount: 2 }
      );
      const words = result.terms.map((x) => x.text);
      t.ok(words.includes('openai'), 'English token expected');
      t.ok(words.some((w) => w.includes('人工智能')), 'Chinese token expected');
      t.equal(result.langMix.mixed, 4);
    }
  },
  {
    name: 'hashtags are kept as single tokens and mentions are optional',
    run(t) {
      const withTags = analyze(docs(['#AI is hot #ai everywhere', 'Talking about #ai again']), { minCount: 1 });
      t.ok(withTags.terms.some((x) => x.text === '#ai'), 'hashtag expected');

      const noMentions = analyze(docs(['@elonmusk posted again', 'reply to @elonmusk']), { minCount: 1 });
      t.ok(!noMentions.terms.some((x) => x.text === '@elonmusk'), 'mentions off by default');

      const withMentions = analyze(docs(['@elonmusk posted again', 'reply to @elonmusk']), {
        includeMentions: true,
        minCount: 1
      });
      t.ok(withMentions.terms.some((x) => x.text === '@elonmusk'), 'mention expected when enabled');
    }
  },
  {
    name: 'urls are ignored',
    run(t) {
      const result = analyze(docs(['check https://example.com/page?utm=1 for details about rockets']), {
        minCount: 1
      });
      const words = result.terms.map((x) => x.text);
      t.ok(words.includes('rockets') || words.includes('rocket'), 'real word expected');
      t.ok(!words.some((w) => w.includes('example')), 'url parts must not appear');
    }
  },
  {
    name: 'extra stop words are honoured in both languages',
    run(t) {
      const result = analyze(
        docs([
          'rocket launch today 火箭发射成功',
          'another rocket launch 火箭发射顺利',
          'rocket launch again 火箭发射完成'
        ]),
        { extraStopwords: ['rocket', '火箭'], minCount: 1 }
      );
      const words = result.terms.map((x) => x.text);
      t.ok(!words.includes('rocket'), 'english stop word applied');
      t.ok(!words.some((w) => w.startsWith('火箭')), 'chinese stop word applied');
    }
  },
  {
    name: 'weightBy switches between document frequency and raw occurrences',
    run(t) {
      const corpus = docs(['spam spam spam spam', 'ham', 'ham']);
      const byDoc = analyze(corpus, { weightBy: 'docFreq', minCount: 1, minPhraseCount: 99 });
      const byCount = analyze(corpus, { weightBy: 'count', minCount: 1, minPhraseCount: 99 });
      t.equal(byDoc.terms[0].text, 'ham');
      t.equal(byCount.terms[0].text, 'spam');
    }
  },
  {
    name: 'minCount filters rare noise',
    run(t) {
      const result = analyze(docs(['alpha beta', 'alpha gamma', 'alpha delta']), {
        minCount: 2,
        minPhraseCount: 99
      });
      t.deepEqual(result.terms.map((x) => x.text), ['alpha']);
    }
  },
  {
    name: 'compareTerms reports rising and falling words',
    run(t) {
      const current = [
        { text: 'rocket', lang: 'en', weight: 10 },
        { text: 'market', lang: 'en', weight: 2 }
      ];
      const previous = [
        { text: 'market', lang: 'en', weight: 8 },
        { text: 'election', lang: 'en', weight: 5 }
      ];
      const rows = compareTerms(current, previous);
      t.equal(rows[0].text, 'rocket');
      t.equal(rows[0].delta, 10);
      const election = rows.find((r) => r.text === 'election');
      t.equal(election.current, 0);
      t.equal(election.delta, -5);
    }
  },
  {
    name: 'phrases longer than the n-gram limit are stitched back together',
    run(t) {
      const zh = analyze(
        docs([
          '今晚火箭发射成功，观众欢呼',
          '刚刚传来消息：火箭发射成功',
          '据报道，火箭发射成功',
          '火箭发射成功，团队庆祝',
          '第二次火箭发射成功'
        ])
      );
      const zhWords = zh.terms.map((x) => x.text);
      t.ok(zhWords.includes('火箭发射成功'), `expected 火箭发射成功, got ${zhWords.slice(0, 8).join(',')}`);
      t.ok(!zhWords.includes('火箭发射'), 'overlapping fragment should be gone');
      t.ok(!zhWords.includes('箭发射成'), 'cross-boundary fragment should be gone');

      const en = analyze(
        docs([
          'artificial intelligence regulation debate continues today',
          'the artificial intelligence regulation debate heats up',
          'lawmakers join the artificial intelligence regulation debate',
          'artificial intelligence regulation debate splits experts',
          'more on the artificial intelligence regulation debate'
        ])
      );
      const enWords = en.terms.map((x) => x.text);
      t.ok(
        enWords.includes('artificial intelligence regulation debate'),
        `expected stitched phrase, got ${enWords.slice(0, 5).join(' | ')}`
      );
    }
  },
  {
    name: 'English words are not glued across Chinese text',
    run(t) {
      const result = analyze(
        docs(Array.from({ length: 4 }, () => 'OpenAI 发布新模型 artificial intelligence 领域竞争'))
      );
      const words = result.terms.map((x) => x.text);
      t.ok(!words.some((w) => w.startsWith('openai artificial')), `bogus phrase found in ${words.join(' | ')}`);
      t.ok(words.includes('openai'), 'openai should still be ranked');
    }
  },
  {
    name: 'English phrases do not cross punctuation',
    run(t) {
      const result = analyze(
        docs([
          'Breaking: artificial intelligence regulation lands today, markets swing hard',
          'Breaking: artificial intelligence regulation lands today, markets swing again',
          'Update: artificial intelligence regulation lands today, markets swing wildly',
          'Report: artificial intelligence regulation lands today, markets swing lower'
        ])
      );
      const words = result.terms.map((x) => x.text);
      t.ok(!words.some((w) => w.includes('today markets')), `comma crossed in ${words.join(' | ')}`);
      t.ok(words.some((w) => w.includes('artificial intelligence regulation')), 'phrase should survive');
    }
  },
  {
    name: 'findLongWords only reports single words over the threshold',
    run(t) {
      const corpus = docs([
        'Breaking: institutionalization of artificial intelligence regulation begins today',
        'Breaking: institutionalization of artificial intelligence regulation begins now',
        'Analysts discuss institutionalization and #artificialintelligenceregulation rules',
        'Analysts discuss institutionalization and #artificialintelligenceregulation again'
      ]);
      const found = findLongWords(corpus, 15).map((x) => x.text);
      t.ok(found.includes('institutionalization'), `expected the long word, got ${found.join(' | ')}`);
      t.ok(
        found.includes('#artificialintelligenceregulation'),
        `expected the long hashtag, got ${found.join(' | ')}`
      );
      t.ok(!found.some((w) => /\s/.test(w)), `phrases must never be reported: ${found.join(' | ')}`);
      t.ok(!found.some((w) => w.length <= 15), `short words leaked: ${found.join(' | ')}`);
      t.equal(findLongWords(corpus, 0).length, 0, 'threshold 0 disables detection');
    }
  },
  {
    name: 'findLongWords never reports a whole Chinese sentence or a url',
    run(t) {
      const found = findLongWords(
        docs([
          '人工智能监管新规今天出台，市场行情剧烈波动，投资者普遍观望情绪浓厚',
          '人工智能监管新规今天出台，市场行情剧烈波动，投资者普遍观望情绪浓厚',
          'See https://example.com/a-very-long-path-that-should-never-count for details',
          'See https://example.com/a-very-long-path-that-should-never-count for more'
        ]),
        8
      ).map((x) => x.text);
      t.ok(!found.some((w) => w.length > 8 && /[\u4e00-\u9fff]/.test(w)), `zh sentence leaked: ${found.join(' | ')}`);
      t.ok(!found.some((w) => w.includes('example.com')), `url leaked: ${found.join(' | ')}`);
    }
  },
  {
    name: 'maxWordChars hides long single words but keeps phrases',
    run(t) {
      const corpus = docs([
        'institutionalization of artificial intelligence regulation begins today',
        'institutionalization of artificial intelligence regulation begins now',
        'institutionalization of artificial intelligence regulation begins again',
        'institutionalization of artificial intelligence regulation begins later'
      ]);
      const before = analyze(corpus).terms.map((x) => x.text);
      const after = analyze(corpus, { maxWordChars: 15 }).terms.map((x) => x.text);
      t.ok(before.includes('institutionalization'), 'long word should be present by default');
      t.ok(!after.includes('institutionalization'), `long word should be hidden: ${after.join(' | ')}`);
      t.ok(
        after.some((w) => w.includes('artificial intelligence regulation')),
        `long phrases must survive: ${after.join(' | ')}`
      );
    }
  },
  {
    name: 'every alert sound renders audible audio',
    async run(t) {
      for (const preset of SOUND_PRESETS) {
        const seconds = soundDuration(preset.id) + 0.2;
        const ctx = new OfflineAudioContext(1, Math.ceil(44100 * seconds), 44100);
        renderSound(ctx, preset.id, 0.5, 0.01);
        const data = (await ctx.startRendering()).getChannelData(0);
        let peak = 0;
        for (const v of data) peak = Math.max(peak, Math.abs(v));
        t.ok(peak > 0.05, `${preset.id} was silent (peak ${peak.toFixed(4)})`);
        t.ok(peak <= 1, `${preset.id} clipped (peak ${peak.toFixed(4)})`);
      }
    }
  },
  {
    name: 'alert volume scales the sound and 0 is silent',
    async run(t) {
      const peakAt = async (volume) => {
        const ctx = new OfflineAudioContext(1, 44100, 44100);
        renderSound(ctx, 'ping', volume, 0.01);
        const data = (await ctx.startRendering()).getChannelData(0);
        let peak = 0;
        for (const v of data) peak = Math.max(peak, Math.abs(v));
        return peak;
      };
      const loud = await peakAt(0.8);
      const soft = await peakAt(0.2);
      const off = await peakAt(0);
      t.ok(loud > soft * 2, `volume should scale: ${loud} vs ${soft}`);
      t.ok(off === 0, `volume 0 must be silent, got ${off}`);
    }
  },
  {
    name: 'unknown sound ids and volumes fall back safely',
    run(t) {
      t.equal(resolveSoundId('nope'), 'chime');
      t.equal(resolveSoundId(undefined), 'chime');
      t.equal(resolveSoundId('bell'), 'bell');
      t.equal(clampVolume('abc'), 0.3);
      t.equal(clampVolume(5), 1);
      t.equal(clampVolume(-2), 0);
    }
  },
  {
    name: 'empty input is handled',
    run(t) {
      const result = analyze([]);
      t.deepEqual(result.terms, []);
      t.equal(result.docCount, 0);
    }
  },
  {
    name: 'analysis of a realistic timeline stays fast',
    run(t) {
      const samples = [
        'Breaking: the market reacts to the new artificial intelligence rules',
        '人工智能监管新规出台，市场反应强烈',
        'OpenAI 发布新模型，开发者社区讨论热烈',
        'Investors watch artificial intelligence stocks closely today',
        '今天的市场行情继续走高，科技股领涨'
      ];
      const corpus = docs(Array.from({ length: 2000 }, (_, i) => samples[i % samples.length]));
      const started = Date.now();
      const result = analyze(corpus, { minCount: 2 });
      const elapsed = Date.now() - started;
      t.ok(result.terms.length > 5, 'should produce terms');
      t.ok(elapsed < 5000, `analysis took ${elapsed}ms`);
    }
  }
];
