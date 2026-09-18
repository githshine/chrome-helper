/**
 * Stop word lists for the bilingual tokenizer.
 */

export const EN_STOPWORDS = new Set(`a about above after again against all almost also although always am among an and
another any anyone anything are aren't around as at back be became because become been before began being below best
better between both but by came can cannot can't come could couldn't did didn't do does doesn't doing don't done down
during each either else enough etc even ever every everyone everything few for from further get gets getting give given
go goes going gone got had hadn't has hasn't have haven't having he he's her here hers herself him himself his how
however i i'd i'll i'm i've if in into is isn't it it's its itself just keep kept know known let let's like likely made
make makes many may maybe me might mine more most much must my myself need needs never new next no nor not nothing now
of off often on once one only or other others ought our ours ourselves out over own per perhaps please put quite rather
re really right said same saw say says see seen seems several shall she she's should shouldn't since so some someone
something soon still such take taken than that that's the their theirs them themselves then there there's these they
they're thing things think this those though through thus to together too took toward under until up upon us use used
using very via want was wasn't way we we're well went were weren't what when where whether which while who whom whose
why will with within without won't would wouldn't yes yet you you're your yours yourself yourselves
amp rt http https www com href nbsp`.split(/\s+/).filter(Boolean));

/**
 * Single characters used to cut Chinese text into candidate word segments.
 * Only function words that virtually never sit inside a content word belong here —
 * characters such as 人, 中, 和 or 一 must stay out so that words like 人工智能,
 * 中国 or 统一 survive segmentation.
 */
export const ZH_SPLIT_CHARS = new Set(
  '的了着过地得吗呢吧啊呀嘛啦么是在我你他她它们这那都也很就还又把被让给向往从对于与之而或及以并且但却则因所才请若虽每某些什怎哪谁'.split('')
);

/**
 * Multi-character function words. They are removed from the text before
 * segmentation, so they neither become terms nor glue two real words together.
 */
export const ZH_STOPWORDS = new Set(`我们 你们 他们 她们 它们 咱们 自己 这个 那个 一个 一些 一样 一直 一定 一起 一点
一下 一切 一般 什么 怎么 怎样 这样 那样 这些 那些 这么 那么 这种 那种 因为 所以 但是 如果 或者 而且 虽然 然后 现在 已经
可以 应该 可能 觉得 知道 时候 没有 不是 不能 不会 不要 不过 不少 不但 大家 真的 还是 就是 只是 其实 当然 目前 通过 关于
对于 由于 以及 并且 进行 出来 起来 下来 上去 下去 表示 认为 例如 比如 需要 今天 昨天 明天 为了 非常 特别 以前 之后 之前
以后 其他 另外 因此 于是 不仅 而是 还有 以上 以下 左右 同时 此外 如此 无论 除了 包括 有些 有的 的话 之类 这里 那里 哪里
多少 一方面 另一方面`.split(/\s+/).filter(Boolean));

/** Single characters that should never begin or end a Chinese n-gram. */
export const ZH_BOUNDARY_CHARS = new Set(
  '的了着过地得吗呢吧啊呀嘛啦么之而或及其此该且但却则很也就都还把被从向往并'.split('')
);
