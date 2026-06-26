# Étape 1: Installation des dépendances et build
FROM --platform=linux/amd64 node:24-slim AS builder

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

WORKDIR /repo

COPY pnpm-lock.yaml .
COPY pnpm-workspace.yaml .
COPY package.json .

COPY apps/worker/package.json ./apps/worker/
COPY packages/domain/package.json ./packages/domain/
COPY packages/database/package.json ./packages/database/
COPY packages/workflow/package.json ./packages/workflow/

RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile

COPY . .

# `...` builds @template/worker AND its workspace dependencies (domain, database, workflow).
RUN pnpm --filter "@template/worker..." build

RUN pnpm deploy --legacy --filter=@template/worker --prod /prod/worker

# ---
# Étape 2: Image de production finale (distroless : pas de shell ni de package manager)
FROM gcr.io/distroless/nodejs24-debian12 AS production

WORKDIR /app

# `nonroot` (uid 65532) est fourni par l'image distroless : pas besoin de créer un user
COPY --from=builder --chown=nonroot:nonroot /prod/worker .

# 8081 = health check server, 34431 = cluster runner socket
EXPOSE 8081 34431

USER nonroot

# L'entrypoint de l'image distroless est déjà `node`. La config DB est lue depuis process.env
# (cf. PgLive / layerDotEnvAdd) — fournir DB_* au runtime via env_file/environment.
CMD ["build/esm/main.js"]
