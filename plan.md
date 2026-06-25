# Implementation Plan — ETL CoinGecko Worker

## Goal
Extend the existing cluster worker (`apps/worker`) and workflow package (`packages/workflow`) with two durable workflows that fetch, transform, and persist data from the CoinGecko API using `@effect/workflow` and `@effect/cluster`.

---

## Unresolved Ambiguities (need decision before implementation)

1. **DB table `demo_price_snapshots`** — does not exist yet. We need either a migration script or a DDL statement to create it. The convention in this codebase has no existing migration infrastructure (no `migrations/` folder, no `@effect/sql-pg` migrator usage). **Decision required**: generate a raw SQL file or skip table creation and assume it exists?

2. **`CoinEnrichWorkflow` was truncated in the brief** — the task description cuts off mid-sentence. I'll infer the second activity (`fetchCoinDetail` → persist to a `demo_coin_details` table) but this needs validation.

---

## Tasks

### Phase 1 — New files in `packages/workflow/src/coingecko/`

#### 1. Create `CoinGeckoSchemas.ts`
- **File**: `packages/workflow/src/coingecko/CoinGeckoSchemas.ts`
- **Changes**: Define `Schema.Struct` for CoinGecko API responses.
  - `CoinMarket`: id, symbol, name, currentPrice (number), marketCap (number|null), priceChangePercentage24h (number|null), lastUpdated (string)
  - `CoinDetail`: id, symbol, name, description (string|null), homepageUrl (string|null), categories (array of strings), marketCapRank (number|null)
  - `PricePoint`: timestamp (number — unix ms), price (number)
- **Acceptance**: Schema parse/encode round-trips with real CoinGecko JSON samples.

#### 2. Create `CoinGeckoClient.ts`
- **File**: `packages/workflow/src/coingecko/CoinGeckoClient.ts`
- **Changes**:
  - `Effect.Service` tagged as `CoinGeckoClient`
  - Depends on `HttpClient` from `@effect/platform`
  - Base URL built from `Config.string("COINGECKO_BASE_URL")` with default `"https://api.coingecko.com/api/v3"`
  - Methods:
    - `getMarkets(): Effect<CoinMarket[], RateLimitError | HttpClientError>` — calls `/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=100&page=1&sparkline=false`
    - `getCoinDetail(id: string): Effect<CoinDetail, RateLimitError | HttpClientError>` — calls `/coins/{id}?localization=false&tickers=false&market_data=false&community_data=false&developer_data=false`
    - `getMarketChart(id: string): Effect<PricePoint[], RateLimitError | HttpClientError>` — calls `/coins/{id}/market_chart?vs_currency=usd&days=1`
  - HTTP 429 detection: check if `HttpClientError` is a `ResponseError` with status 429 → return typed `RateLimitError`
  - `RateLimitError` is a `Data.TaggedError("RateLimitError")` with `retryAfter` (number | undefined)
  - **No built-in throttling** — throttling is applied by the caller (activities use `Effect.delay`)
- **Acceptance**: Unit-testable; a mock HttpClient returns known JSON and the service decodes correctly.

#### 3. Create `PriceSnapshotWorkflow.ts`
- **File**: `packages/workflow/src/coingecko/PriceSnapshotWorkflow.ts`
- **Changes**:
  - Payload: `Schema.Struct({ runId: Schema.String })`
  - Idempotency key: `({ runId }) => runId`
  - Success: `Schema.Void`
  - Error: `Schema.Never`
  - Workflow definition: `Workflow.make({ name: "PriceSnapshotWorkflow", payload: ..., idempotencyKey: ..., success: Schema.Void, error: Schema.Never })`
  - Export the workflow as `PriceSnapshotWorkflow`
- **Acceptance**: `PriceSnapshotWorkflow.name === "PriceSnapshotWorkflow"`, `PriceSnapshotWorkflow.payloadSchema` is a `Schema.Struct`.

#### 4. Create `PriceSnapshotWorker.ts`
- **File**: `packages/workflow/src/coingecko/PriceSnapshotWorker.ts`
- **Changes**:
  - Worker function: `(payload: { runId: string }, _executionId: string) => Effect.gen`
  - Activities defined inline or via `Activity.make`:
    - **Activity "fetchMarkets"**:
      - Calls `CoinGeckoClient.getMarkets()`
      - Retry: `Schedule.exponential("2 seconds").pipe(Schedule.jittered, Schedule.compose(Schedule.recurs(5)))`
      - Throttle: `Effect.delay("2 seconds")` applied before the call
    - **Activity "calculateVariations"**:
      - Pure transform: map markets to snapshot rows (add computed `priceChangePercent` if not already present)
      - No retry needed
    - **Activity "insertSnapshots"**:
      - `sql\`INSERT INTO demo_price_snapshots (coin_id, symbol, name, current_price, market_cap, price_change_pct, captured_at) VALUES ${sql.insert(rows)}\``
      - Retry: `Activity.retry({ times: 3 })`
      - Depends on `PgClient` (from `@template/database`)
  - Export `PriceSnapshotWorker` as the worker function
- **Acceptance**: Worker runs the three activities sequentially and inserts rows into the DB.

#### 5. Create `CoinEnrichWorkflow.ts`
- **File**: `packages/workflow/src/coingecko/CoinEnrichWorkflow.ts`
- **Changes**:
  - Payload: `Schema.Struct({ coinId: Schema.String })`
  - Idempotency key: `({ coinId }) => \`enrich-${coinId}-${Date.now()}\``
  - Success: `Schema.Void`
  - Error: `Schema.Never`
  - Workflow definition
  - Export as `CoinEnrichWorkflow`
- **Acceptance**: Workflow builds correctly.

#### 6. Create `CoinEnrichWorker.ts`
- **File**: `packages/workflow/src/coingecko/CoinEnrichWorker.ts`
- **Changes**:
  - Worker function with two activities:
    - **Activity "fetchCoinDetail"**:
      - Calls `CoinGeckoClient.getCoinDetail(payload.coinId)`
      - Retry: `Schedule.exponential("2 seconds").pipe(Schedule.jittered, Schedule.compose(Schedule.recurs(5)))`
      - Throttle: `Effect.delay("2 seconds")`
    - **Activity "insertCoinDetail"**:
      - `sql\`INSERT INTO demo_coin_details (coin_id, symbol, name, description, homepage_url, categories, market_cap_rank, enriched_at) VALUES (...)\``
      - Retry: `Activity.retry({ times: 3 })`
  - Export `CoinEnrichWorker`
- **Acceptance**: Worker fetches + persists a coin detail record.

### Phase 2 — Register workflows in `apps/worker/src/main.ts`

#### 7. Update `main.ts` — wire workflow layers
- **File**: `apps/worker/src/main.ts`
- **Changes**:
  - Replace the scaffold comment block with actual `toLayer` calls:
    ```ts
    import { PriceSnapshotWorkflow, CoinEnrichWorkflow } from "@template/workflow/coingecko"

    const PriceSnapshotWorkflowLayer = PriceSnapshotWorkflow.toLayer(PriceSnapshotWorker).pipe(
      Layer.provide(CoinGeckoClient.Default),
      Layer.provide(ClusterEngineLayer),
      Layer.provide(RunnerLayer),
      Layer.provide(BaseDependenciesLayer)
    )

    const CoinEnrichWorkflowLayer = CoinEnrichWorkflow.toLayer(CoinEnrichWorker).pipe(
      Layer.provide(CoinGeckoClient.Default),
      Layer.provide(ClusterEngineLayer),
      Layer.provide(RunnerLayer),
      Layer.provide(BaseDependenciesLayer)
    )

    const MainLayer = Layer.mergeAll(PriceSnapshotWorkflowLayer, CoinEnrichWorkflowLayer)
    ```
  - Replace `Effect.never` with `Layer.launch(MainLayer)` (remove the log + `Effect.never`)
  - Remove the `// ──────────────────────` scaffold comment block
- **Acceptance**: On startup, the worker registers both workflows with the cluster engine.

### Phase 3 — Dependencies & wiring

#### 8. Update `packages/workflow/package.json` dependencies
- **File**: `packages/workflow/package.json`
- **Changes**: No new deps needed. `@effect/platform` and `@effect/sql-pg` are already listed. The `@effect/workflow` package brings in `Workflow` and `Activity`.
- **Acceptance**: `pnpm install` succeeds without changes (already installed).

#### 9. Add `packages/workflow/src/coingecko/index.ts`
- **File**: `packages/workflow/src/coingecko/index.ts`
- **Changes**: Re-export all public symbols:
  ```ts
  export * from "./CoinGeckoSchemas.js"
  export * from "./CoinGeckoClient.js"
  export * from "./PriceSnapshotWorkflow.js"
  export * from "./PriceSnapshotWorker.js"
  export * from "./CoinEnrichWorkflow.js"
  export * from "./CoinEnrichWorker.js"
  ```
- **Acceptance**: Consumers can import from `@template/workflow/coingecko`.

### Phase 4 — DB schema (if decision says to create it)

#### 10. Create migration SQL file
- **File**: `packages/database/migrations/001_create_price_snapshots.sql`
- **Changes**:
  ```sql
  CREATE TABLE IF NOT EXISTS demo_price_snapshots (
    id SERIAL PRIMARY KEY,
    run_id TEXT NOT NULL,
    coin_id TEXT NOT NULL,
    symbol TEXT NOT NULL,
    name TEXT NOT NULL,
    current_price NUMERIC,
    market_cap NUMERIC,
    price_change_pct NUMERIC,
    captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS demo_coin_details (
    id SERIAL PRIMARY KEY,
    coin_id TEXT NOT NULL UNIQUE,
    symbol TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    homepage_url TEXT,
    categories TEXT[],
    market_cap_rank INTEGER,
    enriched_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  ```

---

## Files to Modify

| File | Change |
|---|---|
| `apps/worker/src/main.ts` | Wire `PriceSnapshotWorkflowLayer` + `CoinEnrichWorkflowLayer` into `MainLayer`, replace `Effect.never` with `Layer.launch(MainLayer)` |

## New Files

| File | Purpose |
|---|---|
| `packages/workflow/src/coingecko/CoinGeckoSchemas.ts` | Schema definitions for CoinGecko API responses |
| `packages/workflow/src/coingecko/CoinGeckoClient.ts` | Typed HTTP client wrapping CoinGecko API, `Effect.Service` |
| `packages/workflow/src/coingecko/PriceSnapshotWorkflow.ts` | Workflow definition for price snapshot |
| `packages/workflow/src/coingecko/PriceSnapshotWorker.ts` | Worker implementation (3 activities) |
| `packages/workflow/src/coingecko/CoinEnrichWorkflow.ts` | Workflow definition for coin enrichment |
| `packages/workflow/src/coingecko/CoinEnrichWorker.ts` | Worker implementation (2 activities) |
| `packages/workflow/src/coingecko/index.ts` | Barrel re-export |
| `packages/database/migrations/001_create_price_snapshots.sql` | (If decision allows) DDL for new tables |

## Dependencies

```
1 (Schemas) ──> 2 (Client) ──> 3+4 (PriceSnapshot Workflow+Worker)
                              ─> 5+6 (CoinEnrich Workflow+Worker)
                                     ─> 7 (main.ts wiring)
                                     ─> 9 (coingecko/index.ts)
```

- Tasks 1–2 must be done before 3–6
- Tasks 3–6 must be done before 7 and 9
- Task 8 (package.json) can be done anytime; likely no changes needed
- Task 10 (migration) is optional / pending decision

## Risks

1. **Missing DB table**: if `demo_price_snapshots` / `demo_coin_details` don't exist, the insert activities will fail with `SqlError`. The plan assumes we either create them (task 10) or they're pre-created.
2. **`CoinGeckoClient` needs `HttpClient` from `@effect/platform`**: `FetchHttpClient.layer` is already in `BaseDependenciesLayer` in `main.ts` — the client service depends on `HttpClient` tag, so it will be satisfied. Verify the `HttpClient` tag is the same one used by `FetchHttpClient.layer`.
3. **Rate limit without API key**: CoinGecko free tier is 10–30 calls/min. The 2-second delay between activities should keep us well under 30 req/min. But if multiple workflow executions run simultaneously, we could exceed. Consider adding a shared `DurableRateLimiter` if concurrent runs become an issue.
4. **`@effect/workflow` version alignment**: `@effect/workflow@0.18.2` is in `.pnpm` — verify the `Workflow.make` / `Activity.make` API matches this version (the `.d.ts` files read confirm the API surface).
5. **`effect` package `generateExports` config**: The `packages/workflow/package.json` has `effect.generateExports.include: ["**/*.ts"]` which will auto-generate export entries for the new `coingecko/` directory. Need to ensure the build step re-runs `codegen` after adding new files, or manually update `index.ts`.
6. **Idempotency key for `CoinEnrichWorkflow`**: Using `Date.now()` makes each execution unique — intentional if we want to re-enrich the same coin multiple times. But if we want exactly-once enrichment per coin, use just `coinId` instead.

## Verification

- Run `pnpm check` from root — TypeScript compilation must succeed
- Run `pnpm --filter @template/worker start` — worker must start and log registration of both workflows
- Optionally test via `curl` (if an HTTP trigger endpoint exists in the future) or via the cluster's REST API
