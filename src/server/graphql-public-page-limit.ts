import {
  GraphQLError,
  type SelectionSetNode,
  type ValidationContext,
  type ValidationRule,
} from 'graphql';

/**
 * One public status page per GraphQL operation.
 *
 * The page is the only field an anonymous caller can select, and each one
 * composes a whole page: services, incidents, their timelines and windows, all
 * under one transaction. GraphQL lets a caller alias the same field as often as
 * it likes, so one 6 KB request aliasing `publicStatusPage` a hundred times ran
 * a hundred compositions against a pool of ten connections (Epic 3
 * retrospective, R-5). REST has no equivalent: one request is one page.
 *
 * Aliases share the field's name, so counting names catches them. Fragments are
 * followed, because a spread can carry the field too, and two spreads of one
 * fragment count twice: the point is to bound the work, not to model execution
 * exactly.
 *
 * Each fragment is counted once per document and that count is reused at every
 * spread. Walking it again per spread is exponential in nesting depth, and
 * this rule runs on every request, anonymous ones included (GH #147).
 *
 * Not a Fastify plugin, so it lives outside `src/server/plugins`, which
 * autoload evaluates at boot.
 */

const PUBLIC_PAGE = 'publicStatusPage';

// Counts saturate here, where a double stops being exact.
const MAX = Number.MAX_SAFE_INTEGER;
const add = (a: number, b: number) => Math.min(a + b, MAX);

function countSelections(
  selectionSet: SelectionSetNode,
  context: ValidationContext,
  fragmentCounts: Map<string, number>,
  observe: ((selectionSet: SelectionSetNode) => void) | undefined,
): number {
  observe?.(selectionSet);
  let count = 0;

  for (const selection of selectionSet.selections) {
    if (selection.kind === 'Field') {
      // Only the root field matters: a nested field of the same name would
      // belong to another type.
      if (selection.name.value === PUBLIC_PAGE) count = add(count, 1);
      continue;
    }

    if (selection.kind === 'InlineFragment') {
      count = add(
        count,
        countSelections(
          selection.selectionSet,
          context,
          fragmentCounts,
          observe,
        ),
      );
      continue;
    }

    const name = selection.name.value;
    const known = fragmentCounts.get(name);
    if (known !== undefined) {
      // Also reached while the fragment is still being counted, which is a
      // cycle: illegal GraphQL that another rule reports. Contributing 0 keeps
      // the walk finite while that rule has its say.
      count = add(count, known);
      continue;
    }
    const fragment = context.getFragment(name);
    if (!fragment) continue;
    fragmentCounts.set(name, 0);
    const own = countSelections(
      fragment.selectionSet,
      context,
      fragmentCounts,
      observe,
    );
    fragmentCounts.set(name, own);
    count = add(count, own);
  }

  return count;
}

/** `observe` is a test seam that production never passes. */
export function createOnePublicPagePerOperation(
  observe?: (selectionSet: SelectionSetNode) => void,
): ValidationRule {
  return (context) => {
    // Per document: a fragment's count does not depend on the path that
    // reached it, so it is computed once. Created here, never outside the
    // closure, or one request's counts would leak into the next.
    const fragmentCounts = new Map<string, number>();
    return {
      OperationDefinition(operation) {
        const selected = countSelections(
          operation.selectionSet,
          context,
          fragmentCounts,
          observe,
        );
        if (selected > 1) {
          context.reportError(
            new GraphQLError(
              `${PUBLIC_PAGE} may be selected once per operation; this one selects it ${selected >= MAX ? `at least ${MAX}` : selected} times`,
              { nodes: [operation] },
            ),
          );
        }
      },
    };
  };
}

export const onePublicPagePerOperation = createOnePublicPagePerOperation();
