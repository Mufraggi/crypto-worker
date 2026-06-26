/**
 * Convention de ce package — un workflow vit dans `src/<name>/` :
 *  - `<Name>Workflow.ts` : `Workflow.make({ name, success, error, payload, idempotencyKey })`
 *  - `<Name>Worker.ts`   : `(payload, executionId) => Effect.gen(...)` qui appelle le service
 *  - `Service<Name>.ts`  : `Effect.Service` (business logic), dépend des repositories de `@template/database`
 *
 * Le worker enregistre `<Name>Workflow.toLayer(<Name>Worker)` et l'agrège dans son `MainLayer`.
 */
export * as Workflow from "./Workflow.js"

/**
 * CoinEnrichWorkflow — fetches metadata for a single coin from CoinGecko and upserts it into
 * demo_coin_details. Bundles the tagged error, the durable handle, the business logic and the
 * Activity-based logic adapter.
 *
 * 1. Tagged error — propagated on the workflow error channel (cluster handles retry/dedup).
 */
export * as CoinEnrichWorkflow from "./coingecko/CoinEnrichWorkflow.js"

/**
 * CoinGecko HTTP client, injectable via `Effect.Service`.
 *
 * `.Default` already bundles `FetchHttpClient.layer`, so callers only provide
 * `CoinGeckoClient.Default`. Public API: `getMarkets`, `getCoinDetail`, `getMarketChart`.
 */
export * as CoinGeckoClient from "./coingecko/CoinGeckoClient.js"

/**
 * The only layer that touches raw SQL for the CoinGecko demo tables.
 *
 * Writes use `SqlSchema.void`; `SqlError`s are turned into defects via `Effect.orDie`
 * (a DB failure is a 500, not a business error) and every method carries a span.
 */
export * as CoinGeckoRepository from "./coingecko/CoinGeckoRepository.js"

/**
 * Schema for a single coin market entry from GET /coins/markets.
 */
export * as CoinGeckoSchemas from "./coingecko/CoinGeckoSchemas.js"

/**
 * PriceSnapshotWorkflow — captures a snapshot of the top coin prices from CoinGecko and
 * persists them into demo_price_snapshots. Bundles the tagged error, the durable handle, the
 * business logic and the Activity-based logic adapter.
 *
 * 1. Tagged error — propagated on the workflow error channel (cluster handles retry/dedup).
 */
export * as PriceSnapshotWorkflow from "./coingecko/PriceSnapshotWorkflow.js"
