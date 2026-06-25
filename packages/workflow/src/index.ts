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
 * Worker for CoinEnrichWorkflow.
 *
 * Two sequential steps:
 *  1. Fetch coin detail from CoinGecko
 *  2. Upsert into demo_coin_details
 *
 * All errors are caught and logged to satisfy the Never error schema.
 */
export * as CoinEnrichWorker from "./coingecko/CoinEnrichWorker.js"

/**
 * Workflow that fetches detailed metadata for a single coin from CoinGecko
 * and persists it to the demo_coin_details table.
 */
export * as CoinEnrichWorkflow from "./coingecko/CoinEnrichWorkflow.js"

export * as CoinGeckoClient from "./coingecko/CoinGeckoClient.js"

/**
 * Schema for a single coin market entry from GET /coins/markets.
 */
export * as CoinGeckoSchemas from "./coingecko/CoinGeckoSchemas.js"

/**
 * Worker for PriceSnapshotWorkflow.
 *
 * Three sequential steps:
 *  1. Fetch top-100 markets from CoinGecko
 *  2. Transform to snapshot rows (pure)
 *  3. Insert rows into demo_price_snapshots
 *
 * All errors are caught and logged to satisfy the Never error schema.
 */
export * as PriceSnapshotWorker from "./coingecko/PriceSnapshotWorker.js"

/**
 * Workflow that captures a snapshot of top coin prices from CoinGecko
 * and persists them to the demo_price_snapshots table.
 */
export * as PriceSnapshotWorkflow from "./coingecko/PriceSnapshotWorkflow.js"
