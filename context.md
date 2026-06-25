# Code Context — Scout Audit pour `packages/cluster-demo` (ETL CoinGecko)

## 1. Versions effect/cluster, effect/workflow, effect/sql-pg

### Versions résolues (pnpm-lock.yaml)

| Package | Version résolue | Fichier:ligne |
|---|---|---|
| `@effect/cluster` | **0.59.0** | `pnpm-lock.yaml:307` |
| `@effect/workflow` | **0.18.2** | `pnpm-lock.yaml:386` |
| `@effect/sql-pg` | **0.52.1** | `pnpm-lock.yaml:365` |
| `@effect/platform-node` | **0.107.0** | `pnpm-lock.yaml:335` |
| `effect` | **3.21.4** | `pnpm-lock.yaml:402` |

Les `package.json` déclarent tous `"latest"`. Les vraies versions sont dans le lock file.

### NodeClusterSocket ou NodeClusterRunnerSocket ?

**NodeClusterSocket** — confirmé par l'import dans :

- `apps/worker/src/main.ts:3` : `import { NodeClusterSocket, NodeRuntime } from "@effect/platform-node"`
- `apps/worker/src/main.ts:11-16` : `NodeClusterSocket.layer({ shardingConfig: { ... } })`

C'est donc `NodeClusterSocket` (pas `NodeClusterRunnerSocket`).

---

## 2. Config Postgres existante

### Fichier source

`packages/database/src/Sql.ts` (lignes 1-58)

### Variables d'environnement utilisées

| Variable | Default | Usage |
|---|---|---|
| `DB_HOST` | — | host PostgreSQL |
| `DB_USER` | — | user |
| `DB_PORT` | — | port |
| `DB_PWD` | — | password |
| `DB_NAME` | — | database name |
| `ENV` | — | `"production"` ou host contient `"azure.com"` → SSL activé |
| `DB_POOL_SIZE` | `10` | taille du pool |
| `DB_POOL_ACQUIRE_TIMEOUT_MS` | `10000` | timeout acquisition connexion (ms) |

### URL construite

```
postgres://${DB_USER}:${DB_PWD}@${DB_HOST}:${DB_PORT}/${DB_NAME}
```

### Layer exporté

```
PgLive = PgClient.layer({
  url: Redacted.make(url),
  ssl,                                    // true si production/azure
  maxConnections: poolSize,
  connectTimeout: Duration.millis(acquireTimeoutMs),
  transformQueryNames: String.camelToSnake,
  transformResultNames: String.snakeToCamel,
  types: pgTypes                          // garde dates en string
})
```

Le layer charge `.env` via `PlatformConfigProvider.layerDotEnv` et dépend de `NodeContext.layer`.

### Fichier .env.example de référence

`.env.example` (lignes 1-12) — confirme exactement les mêmes variables.

Le cluster-demo doit utiliser **exactement les mêmes variables d'env** pour partager la même base Postgres.

---

## 3. Structure du monorepo

### Workspace (pnpm)

`pnpm-workspace.yaml:2-3` :
```yaml
packages:
  - packages/*
  - apps/*
```

### Packages existants

| Package | Path | npm name |
|---|---|---|
| domain | `packages/domain` | `@template/domain` |
| database | `packages/database` | `@template/database` |
| workflow | `packages/workflow` | `@template/workflow` |
| worker | `apps/worker` | `@template/worker` |

### Convention de nommage

`@template/<name>` — pas de scope personnalisé. Pour un cluster-demo : `@template/cluster-demo`.

### tsconfig.base.json — Paths partagés

`tsconfig.base.json:32-43` :
```json
"paths": {
  "@template/domain":       ["./packages/domain/src/index.js"],
  "@template/domain/*":     ["./packages/domain/src/*.js"],
  "@template/database":     ["./packages/database/src/index.js"],
  "@template/database/*":   ["./packages/database/src/*.js"],
  "@template/workflow":     ["./packages/workflow/src/index.js"],
  "@template/workflow/*":   ["./packages/workflow/src/*.js"],
}
```

**Pour ajouter un package** :
1. Créer `packages/cluster-demo/` avec son `package.json` (`@template/cluster-demo`)
2. Ajouter l'entrée dans `tsconfig.base.json` paths
3. Ajouter `{ "path": "packages/cluster-demo" }` dans `tsconfig.json` et `tsconfig.build.json`

---

## 4. Tables Postgres existantes (cluster_*)

**Aucune migration ou table `cluster_*` n'existe dans le repo.**

- `find` sur `*.sql` → 0 résultats
- `grep` sur `cluster_` dans tous les fichiers `.ts`, `.sql`, `.json` → 0 résultats
- Aucun dossier `migrations/` nulle part

Les tables de persistance du cluster (`cluster_*`) sont créées automatiquement par `@effect/cluster` via `@effect/sql` au premier démarrage du worker. Le cluster-demo peut donc créer ses propres tables sans risque de conflit avec des migrations manuelles.

---

## 5. Docker / Docker Compose

**Aucun Dockerfile ou docker-compose.yml dans le projet.**

- `find` sur `**/Dockerfile` → rien
- `find` sur `**/docker-compose*.{yml,yaml}` → rien
- `.dockerignore` → rien

Seul environnement de dev disponible : Nix shell (`flake.nix`) avec `nodejs` et `corepack`.

Le docker-compose final est à créer from scratch. Recommandation : inclure PostgreSQL + le service worker.

---

## 6. CoinGecko API — endpoints utilisés

**Aucun code CoinGecko n'existe encore** dans le repo (0 résultats pour "coingecko", "coin_gecko", "CoinGecko").

Les endpoints mentionnés sont publics, sans clé API requise :

| Endpoint | Public ? | Rate limit |
|---|---|---|
| `GET /api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=50&page=1&sparkline=false` | ✅ Oui | 30 req/min |
| `GET /api/v3/coins/{id}` | ✅ Oui | 30 req/min |
| `GET /api/v3/coins/{id}/market_chart?vs_currency=usd&days=30` | ✅ Oui | 30 req/min |

Le rate limit public est de **30 requêtes par minute** (pas de clé nécessaire pour ces endpoints en lecture seule).

---

## Architecture — Comment les pièces se connectent

```
┌──────────────────────────────────────────────────────────────┐
│  apps/worker/src/main.ts                                     │
│                                                              │
│  RunnerLayer (NodeClusterSocket)                             │
│    ↓ dépend de                                               │
│  BaseDependenciesLayer = PgLive + FetchHttpClient.layer      │
│    ↓ agrège                                                  │
│  ClusterEngineLayer = ClusterWorkflowEngine.layer            │
│                                                              │
│  ── pour chaque workflow ──                                  │
│  Workflow.toLayer(Worker)                                    │
│    .pipe(Layer.provide(Service.Default))                     │
│    .pipe(Layer.provide(ClusterEngineLayer))                  │
│    .pipe(Layer.provide(RunnerLayer))                         │
│    .pipe(Layer.provide(BaseDependenciesLayer))               │
└──────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────┐
│  packages/database/src/Sql.ts                                │
│                                                              │
│  PgLive : PgClient.layer({ url, ssl, pool, transform... })  │
│    ← lit DB_HOST, DB_USER, DB_PWD, DB_NAME, DB_PORT, ENV    │
│    ← fournit un pool de connexions à tous les workflows      │
└──────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────┐
│  packages/workflow/src/Workflow.ts                           │
│                                                              │
│  Type WorkflowLayer = Layer.Layer<never>                     │
│  Convention : src/<name>/<Name>Workflow.ts + <Name>Worker.ts│
└──────────────────────────────────────────────────────────────┘
```

## Start Here

Le premier fichier à ouvrir est **`apps/worker/src/main.ts`** — il montre le pattern complet d'enregistrement d'un workflow (RunnerLayer, BaseDependenciesLayer, ClusterEngineLayer). Le cluster-demo devra suivre exactement ce pattern : créer un `CoinGeckoWorkflow` + `CoinGeckoWorker` dans `packages/workflow/src/coingecko/`, puis l'enregistrer dans `main.ts`.

Le second fichier est **`packages/database/src/Sql.ts`** pour copier la config Postgres et la réutiliser.

## Contraintes & Risques

1. **Même Postgres** : le cluster-demo doit importer `PgLive` depuis `@template/database` (ou recréer le même layer avec les mêmes variables d'env).
2. **NodeClusterSocket** bien confirmé — utiliser `NodeClusterSocket.layer` dans le cluster-demo.
3. **Ports** : le worker utilise déjà le port 34431 pour le runner. Le health check écoute sur 8081. Le cluster-demo devra utiliser un port différent si déployé séparément (ex: 34432).
4. **Aucune migration existante** — les tables `cluster_*` seront créées automatiquement par `@effect/cluster` via `@effect/sql`.
5. **Rate limit CoinGecko** : 30 req/min, à gérer avec un throttling (ex: `Effect.timed` + `Effect.delay` ou un semaphore).
6. **Docker à créer** from scratch — prévoir un service PostgreSQL dans le docker-compose.
