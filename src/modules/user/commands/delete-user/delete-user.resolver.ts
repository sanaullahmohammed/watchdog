import {
  type DeleteUserCommandResult,
  deleteUserCommand,
} from './delete-user.handler';

export default async function deleteUserResolver(
  fastify: FastifyRouteInstance,
) {
  fastify.graphql.defineResolvers({
    Mutation: {
      deleteUser: async (_, args) =>
        fastify.commandBus.execute<DeleteUserCommandResult>(
          deleteUserCommand({ id: args.id }),
        ),
    },
  });
}
