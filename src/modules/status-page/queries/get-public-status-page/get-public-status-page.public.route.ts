import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { Type } from 'typebox';
import {
  type GetPublicStatusPageQueryResult,
  getPublicStatusPageQuery,
} from './get-public-status-page.handler';
import { publicStatusPageResponseDtoSchema } from './get-public-status-page.schema';

/**
 * `.public.route.ts`, not `.route.ts`: the loader registers these without the
 * `/api` prefix every other route carries, because FR17 names the path
 * `/status/:orgSlug`. The suffix still ends in `.route.ts`, so the parity and
 * authenticated-surface specs discover this file like any other, and a public
 * surface has to be allowlisted deliberately rather than slip past them.
 *
 * No `resolveOrganizationContext` here, by design: there is no session to
 * resolve. The organization comes from the slug, and every read behind it is
 * still tenant-scoped.
 */
export default async function getPublicStatusPage(
  fastify: FastifyRouteInstance,
) {
  fastify.withTypeProvider<TypeBoxTypeProvider>().route({
    method: 'GET',
    url: '/status/:orgSlug',
    schema: {
      description: "Read an organization's public status page",
      params: Type.Object({ orgSlug: Type.String({ minLength: 1 }) }),
      response: { 200: publicStatusPageResponseDtoSchema },
      tags: ['public'],
    },
    handler: async (req, res) => {
      const page =
        await fastify.queryBus.execute<GetPublicStatusPageQueryResult>(
          getPublicStatusPageQuery({ slug: req.params.orgSlug }),
        );

      return res.status(200).send(page);
    },
  });
}
