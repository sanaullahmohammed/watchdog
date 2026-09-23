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
 * Not a Fastify plugin, so it lives outside `src/server/plugins`, which
 * autoload evaluates at boot.
 */

const PUBLIC_PAGE = 'publicStatusPage';

function countSelections(
  selectionSet: SelectionSetNode,
  context: ValidationContext,
  spreads: readonly string[] = [],
): number {
  let count = 0;

  for (const selection of selectionSet.selections) {
    if (selection.kind === 'Field') {
      // Only the root field matters: a nested field of the same name would
      // belong to another type.
      if (selection.name.value === PUBLIC_PAGE) count += 1;
      continue;
    }

    if (selection.kind === 'InlineFragment') {
      count += countSelections(selection.selectionSet, context, spreads);
      continue;
    }

    const name = selection.name.value;
    // A cycle is illegal GraphQL, which another rule reports; this only keeps
    // the walk finite while that rule has its say.
    if (spreads.includes(name)) continue;
    const fragment = context.getFragment(name);
    if (fragment) {
      count += countSelections(fragment.selectionSet, context, [
        ...spreads,
        name,
      ]);
    }
  }

  return count;
}

export const onePublicPagePerOperation: ValidationRule = (context) => ({
  OperationDefinition(operation) {
    const selected = countSelections(operation.selectionSet, context);
    if (selected > 1) {
      context.reportError(
        new GraphQLError(
          `${PUBLIC_PAGE} may be selected once per operation; this one selects it ${selected} times`,
          { nodes: [operation] },
        ),
      );
    }
  },
});
