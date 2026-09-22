/**
 * WatchDog's slug rule: lowercase letters and digits in hyphen-separated runs,
 * at most 120 characters. Services and groups are created under it, and the
 * public page answers only for organization slugs inside it (DOMAIN.md,
 * Better-Auth-owned references). One definition, so the two cannot drift.
 */

export const SLUG_PATTERN = '^[a-z0-9]+(?:-[a-z0-9]+)*$';

export const SLUG_MAX_LENGTH = 120;

const slugPattern = new RegExp(SLUG_PATTERN);

/**
 * Whether a value is inside the rule. Length is checked first, so an input of
 * any size costs no more than 120 characters of matching.
 */
export function isSlug(value: string): boolean {
  return value.length <= SLUG_MAX_LENGTH && slugPattern.test(value);
}
