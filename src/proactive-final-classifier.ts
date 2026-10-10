function normalizeText(text: string): string {
  return text.trim().replace(/\r\n?/g, '\n');
}

function compactSemanticText(text: string): string {
  return normalizeText(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

function semanticBigrams(text: string): Set<string> {
  const characters = [...compactSemanticText(text)];
  const bigrams = new Set<string>();
  for (let index = 0; index + 1 < characters.length; index += 1) {
    bigrams.add(characters[index] + characters[index + 1]);
  }
  return bigrams;
}

function hasMaterialPayload(text: string): boolean {
  return (
    /https?:\/\/|www\./i.test(text) ||
    /```|`[^`]+`|\[[^\]]+\]\([^)]+\)/.test(text) ||
    /(?:^|\n)\s*(?:[-*+]\s+|\d+[.)、]\s+)/m.test(text) ||
    /[:：=@]/.test(text) ||
    /(?:^|\s)[/\\][\p{L}\p{N}_.-]+/u.test(text) ||
    /\d/.test(text) ||
    /(?:根因|结论|结果|原因|修复方式|解决方式|下一步)(?:是|为)/.test(text) ||
    /(?:链接|地址|路径|文件|文档)(?:是|为|位于)/.test(text) ||
    /(?:口令|验证码|确认码).{0,12}\b[A-Z][A-Z0-9_-]{2,}\b/.test(text) ||
    /\b(?:id|url|path)\s*[=:]\s*[\w.-]+/i.test(text) ||
    /\b(?:root cause|because|solution|fix is|result is|conclusion)\b/i.test(
      text,
    )
  );
}

function isCompletionLikeProgress(text: string): boolean {
  return (
    /(?:已经|已)(?:(?!开始|正在).){0,10}(?:完成|做好|就绪|发布|创建|修复|写好)/.test(
      text,
    ) ||
    /(?:完整预览|最终结论|结论是|结果是|根因是|一句话回顾|一句话总结|确认口令)/.test(
      text,
    ) ||
    /\b(?:completed|finished|ready|final (?:answer|result|report)|here(?:'s| is) the (?:result|summary)|root cause|confirmation phrase)\b/i.test(
      text,
    )
  );
}

function isCourtesyClosure(text: string): boolean {
  const normalized = normalizeText(text).replace(/\s+/g, ' ');
  const chineseFollowUp =
    /^(?:(?:等你|等待|请).{0,12}(?:确认|回复|反馈|意见|指示|查收)|(?:如需|需要).{0,12}(?:修改|调整|告诉|回复))[。.!！]?$/;
  if (chineseFollowUp.test(normalized)) return true;

  const chineseCompletion =
    /^(?:(?:草稿|报告|任务|工作|处理|分析|文档|结果).{0,6})?(?:已经|已)?(?:完成|做好|就绪|结束|发布完成)/;
  const completionMatch = normalized.match(chineseCompletion);
  if (completionMatch) {
    const remainder = normalized
      .slice(completionMatch[0].length)
      .replace(/^[，,。；;\s]+/, '')
      .trim();
    return !remainder || chineseFollowUp.test(remainder);
  }

  return /^(?:(?:draft|report|task|work|analysis|document|result)\s+(?:is\s+)?)?(?:done|completed?|finished|ready)(?:[.,;]\s*(?:awaiting .+|waiting for .+|let me know .+|please confirm.*))?[.!]?$/i.test(
    normalized,
  );
}

/**
 * Detect the narrow failure mode where a model already delivered a complete,
 * substantive answer as `progress`, then ended with a short SDK-only courtesy
 * phrase.
 *
 * This deliberately fails open. Structured content, identifiers, paths, links,
 * explicit conclusions, incomplete progress, long candidates, and text without
 * lexical overlap all remain eligible for host recovery.
 */
export function isRedundantProactiveSdkClosure(
  candidate: string,
  deliveredProgressTexts: readonly string[],
): boolean {
  const minimumCompleteProgressLength = 60;
  const normalizedCandidate = normalizeText(candidate);
  const candidateLength = [...normalizedCandidate].length;
  if (
    candidateLength === 0 ||
    candidateLength > 80 ||
    hasMaterialPayload(candidate) ||
    !isCourtesyClosure(candidate)
  ) {
    return false;
  }

  const candidateBigrams = semanticBigrams(candidate);
  for (let index = deliveredProgressTexts.length - 1; index >= 0; index -= 1) {
    const progress = deliveredProgressTexts[index];
    if (
      [...normalizeText(progress)].length < minimumCompleteProgressLength ||
      !isCompletionLikeProgress(progress)
    ) {
      continue;
    }

    const progressBigrams = semanticBigrams(progress);
    let sharedBigrams = 0;
    for (const bigram of candidateBigrams) {
      if (progressBigrams.has(bigram)) sharedBigrams += 1;
    }
    if (sharedBigrams >= 3) return true;
  }
  return false;
}
