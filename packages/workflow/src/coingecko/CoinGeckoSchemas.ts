import { Schema } from "effect"

/**
 * Schema for a single coin market entry from GET /coins/markets.
 */
export const CoinMarket = Schema.Struct({
  id: Schema.String,
  symbol: Schema.String,
  name: Schema.String,
  currentPrice: Schema.Number,
  marketCap: Schema.NullOr(Schema.Number),
  priceChangePercentage24h: Schema.NullOr(Schema.Number),
  lastUpdated: Schema.String
})
export type CoinMarket = typeof CoinMarket.Type

/**
 * Schema for a single coin detail entry from GET /coins/{id}.
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
 * Schema for a single price point from GET /coins/{id}/market_chart.
 */
export const PricePoint = Schema.Struct({
  timestamp: Schema.Number,
  price: Schema.Number
})
export type PricePoint = typeof PricePoint.Type
