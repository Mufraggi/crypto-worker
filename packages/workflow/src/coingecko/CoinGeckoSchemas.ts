import { Schema } from "effect"

/**
 * Schema for a single coin market entry from GET /coins/markets.
 *
 * The API returns snake_case keys; `Schema.fromKey` decodes them into the camelCase domain
 * shape used by the workers (the encoded form stays snake_case).
 */
export const CoinMarket = Schema.Struct({
  id: Schema.String,
  symbol: Schema.String,
  name: Schema.String,
  currentPrice: Schema.propertySignature(Schema.Number).pipe(Schema.fromKey("current_price")),
  marketCap: Schema.propertySignature(Schema.NullOr(Schema.Number)).pipe(Schema.fromKey("market_cap")),
  priceChangePercentage24h: Schema.propertySignature(Schema.NullOr(Schema.Number)).pipe(
    Schema.fromKey("price_change_percentage_24h")
  ),
  lastUpdated: Schema.propertySignature(Schema.String).pipe(Schema.fromKey("last_updated"))
})
export type CoinMarket = typeof CoinMarket.Type

/**
 * Domain shape for a coin detail — flat and camelCase. This is what the worker/repo and the
 * Activity journal use; the client maps the raw API response (see `CoinDetailApi`) into it.
 */
export const CoinDetail = Schema.Struct({
  id: Schema.String,
  symbol: Schema.String,
  name: Schema.String,
  description: Schema.NullOr(Schema.String),
  homepageUrl: Schema.NullOr(Schema.String),
  categories: Schema.Array(Schema.String),
  marketCapRank: Schema.NullOr(Schema.Number)
})
export type CoinDetail = typeof CoinDetail.Type

/**
 * Raw shape of GET /coins/{id} — `description` and `homepage` are nested, and several fields
 * may be absent depending on the query flags, so everything optional is lenient. The client
 * flattens this into `CoinDetail`.
 */
export const CoinDetailApi = Schema.Struct({
  id: Schema.String,
  symbol: Schema.String,
  name: Schema.String,
  description: Schema.optional(Schema.Struct({ en: Schema.optional(Schema.NullOr(Schema.String)) })),
  links: Schema.optional(Schema.Struct({ homepage: Schema.optional(Schema.Array(Schema.String)) })),
  categories: Schema.optional(Schema.Array(Schema.NullOr(Schema.String))),
  marketCapRank: Schema.optional(Schema.NullOr(Schema.Number)).pipe(Schema.fromKey("market_cap_rank"))
})
export type CoinDetailApi = typeof CoinDetailApi.Type

/**
 * Schema for a single price point from GET /coins/{id}/market_chart.
 */
export const PricePoint = Schema.Struct({
  timestamp: Schema.Number,
  price: Schema.Number
})
export type PricePoint = typeof PricePoint.Type
