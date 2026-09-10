# syntax=docker/dockerfile:1

# One image serves `migrate`, `api` and `worker`; the command selects the
# runtime mode. See ARCHITECTURE.md sections 4 and 8.

FROM node:24-alpine AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

FROM base AS prod-deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# --ignore-scripts: the `prepare` hook runs husky, which is a dev dependency and
# irrelevant in an image. dbmate ships its binary via optionalDependencies, so
# nothing in the production tree needs a lifecycle script.
RUN pnpm install --frozen-lockfile --prod --ignore-scripts

FROM deps AS build
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
# tsc emits to dist, then resolve-tspaths rewrites the `@/*` alias to real
# relative paths, because the runtime has no alias resolver.
RUN pnpm run build

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
# dbmate reads the migration and seed directories at runtime.
COPY db ./db
USER node
EXPOSE 3000
CMD ["node", "dist/index.js", "api"]
