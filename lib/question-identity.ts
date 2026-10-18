// 同一道题在作业、错题本和题库里只用一个 ID。题目被拍照识别或经 Word 往返后，文字会有题号、全半角、空格、
// \text{} 之类的细小差别，所以按规范化后的题干和选项判断是不是同一道题。判定从严：规范化后完全一致，或者
// 数字、字母和符号一个不差、文字也几乎一样（例如“一条光线”和“一束光线”）。数字或选项不同的题永远不会合并。

type QuestionText = { stem?: string; options?: string[] };

const LATEX_NOISE = /\\(?:left|right|mathrm|mathbf|text|textbf|textrm|displaystyle|mathrel|mkern[\d.-]*mu|quad|qquad|[,;:! ])/g;
const SYMBOLS: Array<[RegExp, string]> = [
  [/\\(?:triangle|Delta)|△/g, "△"], [/\\angle|∠/g, "∠"], [/\\(?:square|Box|parallelogram)|▱|□/g, "▱"], [/\\parallel|\/\/|∥/g, "∥"], [/\\perp|⊥/g, "⊥"],
  [/\\cdot|·|•/g, "·"], [/\\times|×/g, "×"], [/\\div|÷/g, "÷"], [/\\[dt]frac/g, "\\frac"], [/\\(?:le|leq)(?![a-z])|≤/g, "≤"], [/\\(?:ge|geq)(?![a-z])|≥/g, "≥"],
];

/** 题干和选项规范化后的文字；空题返回空字符串。 */
export function questionFingerprint(question: QuestionText) {
  return [normalizePart(question.stem ?? "", false), ...(question.options ?? []).map((option) => normalizePart(option, true))].filter(Boolean).join("|");
}

function normalizePart(text: string, option: boolean) {
  let value = String(text).normalize("NFKC");
  // 卷面题号、“……”续题标记、分值和选项字母不属于题目本身；小题号 (1)(2) 要保留，它们区分同一大题的不同小问。
  value = value.replace(/^\s*(?:\.{2,}|…+)/, "").replace(/^\s*\d{1,3}\s*[.、:](?!\d)\s*/, "").replace(/^\s*\(\d{1,3}分\)\s*/, "");
  if (option) value = value.replace(/^\s*[A-H]\s*[.、:]\s*/, "");
  value = value.replace(LATEX_NOISE, "");
  for (const [pattern, symbol] of SYMBOLS) value = value.replace(pattern, symbol);
  value = value.replace(/[﹣－–—−]/g, "-").replace(/[。]/g, ".").replace(/[“”"]/g, "").replace(/[′’‘]/g, "'").replace(/_{2,}/g, "_");
  return value.replace(/[\s${}]/g, "").replace(/\(\)/g, "");
}

// 数字、字母和符号的完整序列：两道题只要有一个数、一个字母或一个选项不同，就不是同一道题。
function mathSignature(fingerprint: string) {
  return fingerprint.replace(/[\u3400-\u9fff,.、;:?!《》【】]/g, "");
}

function bigrams(text: string) {
  const grams = new Set<string>();
  for (let index = 0; index < text.length - 1; index += 1) grams.add(text.slice(index, index + 2));
  return grams;
}

const SIMILAR = 0.9;
// 太短的题（“如图，求∠1的度数”）离开配图就分不清，只按完全一致合并较长的题。
const MIN_EXACT_LENGTH = 15;
const MIN_FUZZY_LENGTH = 20;

type Candidate = { key: string; fingerprint: string; signature: string; grams: Set<string> };

/** 在已有题目里找同一道题：先找完全一致的，再找文字几乎一样的；找不到返回 null。 */
export function createQuestionMatcher() {
  const exact = new Map<string, string>();
  const candidates: Candidate[] = [];
  return {
    add(key: string, question: QuestionText) {
      const fingerprint = questionFingerprint(question);
      if (fingerprint.length < MIN_EXACT_LENGTH || exact.has(fingerprint)) return;
      exact.set(fingerprint, key);
      if (fingerprint.length >= MIN_FUZZY_LENGTH) candidates.push({ key, fingerprint, signature: mathSignature(fingerprint), grams: bigrams(fingerprint) });
    },
    find(question: QuestionText): string | null {
      const fingerprint = questionFingerprint(question);
      if (fingerprint.length < MIN_EXACT_LENGTH) return null;
      const same = exact.get(fingerprint);
      if (same) return same;
      if (fingerprint.length < MIN_FUZZY_LENGTH) return null;
      const signature = mathSignature(fingerprint), grams = bigrams(fingerprint);
      let best: { key: string; score: number } | null = null;
      for (const candidate of candidates) {
        if (candidate.signature !== signature) continue;
        let shared = 0;
        for (const gram of grams) if (candidate.grams.has(gram)) shared += 1;
        const score = shared / (grams.size + candidate.grams.size - shared);
        if (score >= SIMILAR && (!best || score > best.score)) best = { key: candidate.key, score };
      }
      return best?.key ?? null;
    },
  };
}
