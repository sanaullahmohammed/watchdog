import type { CheckOutcome, KeywordCheckMetadata } from './check-outcome';
import { type HttpCheckOptions, runHttpRequestCheck } from './http-check';

/**
 * Final 2xx, then at most 1 MiB of the body, decoded as UTF-8, searched
 * case-sensitively for the keyword.
 */
export function runKeywordCheck(
  target: string,
  keyword: string,
  options: HttpCheckOptions,
): Promise<CheckOutcome<KeywordCheckMetadata>> {
  return runHttpRequestCheck(target, options, keyword);
}
