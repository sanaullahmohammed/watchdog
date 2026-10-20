import { statusPageActionCreator } from '@/modules/status-page';
import {
  type GetPublicStatusPageQueryResult,
  getPublicStatusPageQuery,
  type PublicStatusPageView,
} from '@/modules/status-page/queries/get-public-status-page/get-public-status-page.handler';

export type OpenPublicStatusEventStreamQueryResult =
  Promise<PublicStatusPageView>;

/**
 * What a public status stream sends (story 4.5): the page `GET /status/:orgSlug`
 * answers, composed by that page's own query, so the stream applies the same
 * slug rule, the same uniform miss and the same visibility rule.
 *
 * Its own query rather than the route calling the page query directly, because
 * it is the seam story 4.6 recomposes through when a public event arrives. It
 * returns the view, not the response: the presenter and the tag are the api
 * layer, and the route applies them.
 */
export const openPublicStatusEventStreamQuery = statusPageActionCreator<{
  slug: string;
}>('stream.open');

export default function makeOpenPublicStatusStream({ queryBus }: Dependencies) {
  return {
    async handler({
      payload,
    }: ReturnType<
      typeof openPublicStatusEventStreamQuery
    >): OpenPublicStatusEventStreamQueryResult {
      return queryBus.execute<GetPublicStatusPageQueryResult>(
        getPublicStatusPageQuery({ slug: payload.slug }),
      );
    },
    init() {
      queryBus.register(openPublicStatusEventStreamQuery.type, this.handler);
    },
  };
}
