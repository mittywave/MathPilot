// 同一道题在作业、错题本和题库里只用一个 ID。题目被拍照识别或经 Word 往返后，文字会有题号、全半角、空格、
// \text{} 之类的细小差别，所以按规范化后的题干和选项判断是不是同一道题。判定从严：规范化后完全一致，或者
// 数字、字母和符号一个不差、文字也几乎一样（例如“一条光线”和“一束光线”）。数字或选项不同的题永远不会合并。

type QuestionText = { stem?: string; options?: string[] };

const LATEX_NOISE = /\\(?:(?:left|right|displaystyle|quad|qquad)(?![a-z])|mkern[\d.-]*mu|[,;:! ])/g;
const SYMBOLS: Array<[RegExp, string]> = [
  // A blank to fill in is a blank however it was written: ______, \underline{\hspace{2em}}, \underline{\quad}, \_\_.
  [/\\underline\{(?:\\hspace\*?\{[^{}]*\}|\\[,;: ]|~|\s)*\}|(?:\\_)+/g, "_"], [/\\hspace\*?\{[^{}]*\}/g, ""],
  [/\\(?:[lc]?dots[cb]?)(?![a-z])|⋯|…|\.{3}/g, "…"], [/\\(?:triangle|Delta)|△/g, "△"], [/\\angle|∠/g, "∠"], [/\\(?:square|Box|parallelogram)|▱|□/g, "▱"], [/\\parallel|\/\/|∥/g, "∥"], [/\\perp|⊥/g, "⊥"],
  [/\\cdot|·|•/g, "·"], [/\\times|×/g, "×"], [/\\div|÷/g, "÷"], [/\\[dt]frac/g, "\\frac"], [/\\(?:le|leq)(?![a-z])|≤/g, "≤"], [/\\(?:ge|geq)(?![a-z])|≥/g, "≥"],
  [/\^\{?\\circ\}?|°/g, "°"], [/\\pi(?![a-z])|π/g, "π"], [/\\(?:ne|neq)(?![a-z])|≠/g, "≠"], [/\\pm(?![a-z])|±/g, "±"], [/\\because|∵/g, "∵"], [/\\therefore|∴/g, "∴"],
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
  // A note in brackets before the stem, such as its source “（初一计算1000题第64题）” or “（本小题8分）”, is not the
  // question: Chinese words and no mathematics. “(1)” and “(x+1)(x-1)” stay.
  else value = value.replace(/^\s*\((?=[^()]*[\u3400-\u9fff]{2})[^()$\\]*\)\s*/, "");
  // Strip only transparent formatting groups. Fraction/root arguments and all other braces retain their scope.
  value = value.replace(/\\(?:mathrm|mathbf|text|textbf|textrm|mathrel)\s*\{([^{}]*)\}/g, "$1").replace(LATEX_NOISE, "");
  for (const [pattern, symbol] of SYMBOLS) value = value.replace(pattern, symbol);
  value = value.replace(/[﹣－–—−]/g, "-").replace(/[。]/g, ".").replace(/[“”"]/g, "").replace(/[′’‘]/g, "'").replace(/_{2,}/g, "_");
  // A one-token exponent/subscript is the same with braces; a multi-token one is not.
  return value.replace(/[\s$]/g, "").replace(/([_^])\{([^{}])\}/g, "$1$2").replace(/\(\)/g, "");
}

// 数字、字母和符号的完整序列：两道题只要有一个数、一个字母或一个选项不同，就不是同一道题。
function mathSignature(fingerprint: string) {
  return fingerprint.replace(/[\u3400-\u9fff,.、;:?!《》【】]/g, (character, index: number) =>
    /[,.;:]/.test(character) && /[\da-zA-Z]/.test(fingerprint[index - 1] ?? "") && /[\da-zA-Z]/.test(fingerprint[index + 1] ?? "") ? character : "");
}

// The numbers in order: questions that differ in a single number are different questions.
function numbersOf(fingerprint: string) {
  return fingerprint.match(/\d+(?:\.\d+)?/g) ?? [];
}

// Whole questions have the same numbers. A sub-question read on its own has its question's common conditions (the
// start of that question) and then its own part, which comes in that question as one run.
function sameSequence(read: string[], named: string[], part: boolean) {
  if (!part) return read.length === named.length && read.every((number, index) => number === named[index]);
  for (let common = 0; common <= Math.min(read.length, named.length) && read.slice(0, common).every((number, index) => number === named[index]); common += 1) {
    const own = read.slice(common);
    for (let start = common; start + own.length <= named.length; start += 1) if (own.every((number, index) => number === named[start + index])) return true;
  }
  return false;
}

function bigrams(text: string) {
  const grams = new Set<string>();
  for (let index = 0; index < text.length - 1; index += 1) grams.add(text.slice(index, index + 2));
  return grams;
}

// A printed ID is taken when the question read from paper is the one the ID names: its text is in that question and
// its numbers, letters and symbols are the same. A sub-question read on its own only has to be part of its whole
// question. A misread digit naming another question fails this, even a 计算 variant one number away.
const PRINTED_TEXT = 0.75;
const SIMILAR = 0.9;
// 太短的题（“如图，求∠1的度数”）离开配图就分不清，只按完全一致合并较长的题。
const MIN_EXACT_LENGTH = 15;
const MIN_FUZZY_LENGTH = 20;

type Content = { fingerprint: string; signature: string; tokens: string[]; grams: Set<string> };
type Candidate = Content & { key: string };

function content(fingerprint: string): Content {
  const signature = mathSignature(fingerprint), tokens: string[] = [];
  // A sub-question may omit another part, but never start or end a match inside a TeX group.
  for (let index = 0; index < signature.length; index += 1) {
    const start = index;
    if (signature[index] === "{") {
      let depth = 1;
      while (depth && index + 1 < signature.length) {
        index += 1;
        if (signature[index] === "{") depth += 1;
        if (signature[index] === "}") depth -= 1;
      }
    }
    tokens.push(signature.slice(start, index + 1));
  }
  return { fingerprint, signature, tokens, grams: bigrams(fingerprint) };
}

// The share of a's bigrams that b also has; an empty a is contained in anything.
function containment(a: Set<string>, b: Set<string>) {
  if (!a.size) return 1;
  let shared = 0;
  for (const gram of a) if (b.has(gram)) shared += 1;
  return shared / a.size;
}

/** 在已有题目里找同一道题：先找完全一致的，再找文字几乎一样的；找不到返回 null。 */
export function createQuestionMatcher() {
  const exact = new Map<string, string>();
  const candidates: Candidate[] = [];
  // Every known question's own content, short ones too, to check the question a printed ID names.
  const known = new Map<string, Content>();
  return {
    add(key: string, question: QuestionText) {
      const fingerprint = questionFingerprint(question);
      if (fingerprint && !known.has(key)) known.set(key, content(fingerprint));
      if (fingerprint.length < MIN_EXACT_LENGTH || exact.has(fingerprint)) return;
      exact.set(fingerprint, key);
      if (fingerprint.length >= MIN_FUZZY_LENGTH) candidates.push({ key, ...content(fingerprint) });
    },
    /** 纸上印的 ID 指向的题能否当作这道题：文字基本都在那道题里，数字、字母和符号对得上；单独识别的小问只需是那道题的一部分。 */
    confirms(key: string, question: QuestionText, part = false) {
      const named = known.get(key), fingerprint = questionFingerprint(question);
      if (!named || !fingerprint) return false;
      const read = content(fingerprint);
      // Similar prose is allowed; mathematical scope, operators and their order must match exactly.
      return sameSequence(numbersOf(fingerprint), numbersOf(named.fingerprint), part)
        && sameSequence(read.tokens, named.tokens, part) && containment(read.grams, named.grams) >= PRINTED_TEXT;
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
