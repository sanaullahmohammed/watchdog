/**
 * Whether an edit changed anything, so a command can announce a change rather
 * than an attempt.
 *
 * An `*.updated` event triggers a status recomputation and, from Epic 4, wakes
 * every public subscriber. A PATCH that rewrites the same title should do
 * neither (Epic 2 retrospective, D-3, decided 2026-09-23).
 *
 * The comparison is between a row as it was and as it is, not between the
 * request and the row, so a field the patch omits cannot count as a change.
 */

/** Equal for this purpose: dates by their instant, everything else by value. */
function same(left: unknown, right: unknown): boolean {
  if (left instanceof Date || right instanceof Date) {
    return (
      left instanceof Date &&
      right instanceof Date &&
      left.valueOf() === right.valueOf()
    );
  }
  return left === right;
}

/** True when any of `keys` differs between the two rows. */
export function anyChanged<T>(
  before: T,
  after: T,
  keys: readonly (keyof T)[],
): boolean {
  return keys.some((key) => !same(before[key], after[key]));
}

/**
 * True when two collections describe a different set. Order does not matter:
 * the same services in another order is the same cover.
 */
export function sameSet(
  before: readonly string[],
  after: readonly string[],
): boolean {
  if (before.length !== after.length) return false;
  const seen = new Set(before);
  return after.every((value) => seen.has(value));
}
