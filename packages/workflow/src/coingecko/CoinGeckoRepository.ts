import { SqlClient, SqlSchema } from "@effect/sql"
import { PgLive } from "@template/database/Sql"
import { Effect, pipe, Schema } from "effect"
import { CoinDetail } from "./CoinGeckoSchemas.js"

/** One row to persist into `demo_price_snapshots`. `captured_at` is filled by the DB default. */
export const PriceSnapshotRow = Schema.Struct({
  runId: Schema.String,
  coinId: Schema.String,
  symbol: Schema.String,
  name: Schema.String,
  currentPrice: Schema.Number,
  marketCap: Schema.NullOr(Schema.Number),
  priceChangePct: Schema.NullOr(Schema.Number)
})
export type PriceSnapshotRow = typeof PriceSnapshotRow.Type

/**
 * The only layer that touches raw SQL for the CoinGecko demo tables.
 *
 * Writes use `SqlSchema.void`; `SqlError`s are turned into defects via `Effect.orDie`
 * (a DB failure is a 500, not a business error) and every method carries a span.
 */
export class CoinGeckoRepository extends Effect.Service<CoinGeckoRepository>()("CoinGeckoRepository", {
  effect: Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient

    const insertSnapshotSchema = SqlSchema.void({
      Request: PriceSnapshotRow,
      execute: (r) =>
        sql`
          INSERT INTO demo_price_snapshots
            (run_id, coin_id, symbol, name, current_price, market_cap, price_change_pct)
          VALUES
            (${r.runId}, ${r.coinId}, ${r.symbol}, ${r.name},
             ${r.currentPrice}, ${r.marketCap}, ${r.priceChangePct})
        `
    })

    const upsertCoinDetailSchema = SqlSchema.void({
      Request: CoinDetail,
      execute: (d) =>
        sql`
          INSERT INTO demo_coin_details
            (coin_id, symbol, name, description, homepage_url, categories, market_cap_rank)
          VALUES
            (${d.id}, ${d.symbol}, ${d.name}, ${d.description},
             ${d.homepageUrl}, ${d.categories}, ${d.marketCapRank})
          ON CONFLICT (coin_id)
          DO UPDATE SET
            symbol          = EXCLUDED.symbol,
            name            = EXCLUDED.name,
            description     = EXCLUDED.description,
            homepage_url    = EXCLUDED.homepage_url,
            categories      = EXCLUDED.categories,
            market_cap_rank = EXCLUDED.market_cap_rank,
            enriched_at     = NOW()
        `
    })

    return {
      insertPriceSnapshots: (rows: ReadonlyArray<PriceSnapshotRow>) =>
        pipe(
          Effect.forEach(rows, insertSnapshotSchema, { discard: true }),
          Effect.orDie,
          Effect.withSpan("CoinGeckoRepository.insertPriceSnapshots")
        ),
      upsertCoinDetail: (detail: CoinDetail) =>
        pipe(
          upsertCoinDetailSchema(detail),
          Effect.orDie,
          Effect.withSpan("CoinGeckoRepository.upsertCoinDetail")
        )
    }
  }),
  dependencies: [PgLive]
}) {}
