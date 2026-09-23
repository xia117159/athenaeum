import { compileQuickFilter } from "./quickFilterMatcher";
import type { QuickFilterEvaluationRequest, QuickFilterEvaluationResult, QuickFilterNameMatch } from "./quickFilterTypes";

/** Pure Worker entry point. Invalid input re-evaluates the last valid query
 * against the current names, so directory refresh remains live during errors.
 */
export function evaluateQuickFilter(request: QuickFilterEvaluationRequest): QuickFilterEvaluationResult {
  let text = request.text;
  let result = compileQuickFilter(text, "regex", "highlight");
  const error = result.ok ? null : result.message;
  if (!result.ok) {
    if (!request.fallbackText.trim()) return { error, evaluation: null };
    text = request.fallbackText;
    result = compileQuickFilter(text, "regex", "highlight");
    if (!result.ok) return { error, evaluation: null };
  }
  const matches: Record<string, QuickFilterNameMatch> = Object.create(null);
  for (const name of request.names) {
    const matched = result.program.test(name);
    matches[name] = { matched, ranges: request.includeRanges && matched ? result.program.ranges(name) : [] };
  }
  return { error, evaluation: { text, matches } };
}
