import { SqlClient } from "@effect/sql"
import { Effect, Schedule } from "effect"
import { CoinGeckoClient } from "./CoinGeckoClient.js"

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
export const PriceSnapshotWorker = (
  payload: { readonly runId: string },
  _executionId: string
) =>
  Effect.gen(function*() {
    const client = yield* CoinGeckoClient

    // Step 1 — fetch markets from CoinGecko
    const markets = yield* client.getMarkets.pipe(
      Effect.delay("2 seconds"),
      Effect.retry(
        Schedule.exponential("2 seconds").pipe(
          Schedule.jittered,
          Schedule.compose(Schedule.recurs(5))
        )
      ),
      Effect.catchAll((error) =>
        Effect.logError(`PriceSnapshot fetchMarkets failed: ${error}`).pipe(
          Effect.as([] as readonly [])
        )
      )
    )

    // Step 2 — transform (pure)
    const rows = Array.from(markets).map((m) => ({
      runId: payload.runId,
      coinId: m.id,
      symbol: m.symbol,
      name: m.name,
      currentPrice: m.currentPrice,
      marketCap: m.marketCap,
      priceChangePct: m.priceChangePercentage24h,
      capturedAt: new Date().toISOString()
    }))

    // Step 3 — insert into DB
    const sql = yield* SqlClient.SqlClient
    for (const row of rows) {
      yield* sql`
        INSERT INTO demo_price_snapshots
          (run_id, coin_id, symbol, name, current_price, market_cap, price_change_pct, captured_at)
        VALUES
          (${row.runId}, ${row.coinId}, ${row.symbol}, ${row.name},
           ${row.currentPrice}, ${row.marketCap}, ${row.priceChangePct}, ${row.capturedAt})
      `.pipe(
        Effect.retry({ times: 3 }),
        Effect.catchAll((error) => Effect.logError(`PriceSnapshot insertSnapshots failed: ${error}`)),
        Effect.asVoid
      )
    }
  })
