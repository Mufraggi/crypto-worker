import { FetchHttpClient, HttpClient, HttpClientError } from "@effect/platform"
import { Config, Effect, Schema } from "effect"
import { type CoinDetail, CoinDetailApi, CoinMarket } from "./CoinGeckoSchemas.js"

/** Raised when CoinGecko answers HTTP 429 (public rate limit: 30 req/min). */
export class RateLimitError extends Schema.TaggedError<RateLimitError>()("RateLimitError", {
  retryAfter: Schema.optional(Schema.Number)
}) {}

type ClientError = HttpClientError.HttpClientError | RateLimitError

/**
 * CoinGecko HTTP client, injectable via `Effect.Service`.
 *
 * `.Default` already bundles `FetchHttpClient.layer`, so callers only provide
 * `CoinGeckoClient.Default`. Public API: `getMarkets`, `getCoinDetail`, `getMarketChart`.
 */
export class CoinGeckoClient extends Effect.Service<CoinGeckoClient>()("CoinGeckoClient", {
  effect: Effect.gen(function*() {
    const httpClient = yield* HttpClient.HttpClient
    const baseUrl = yield* Config.string("COINGECKO_BASE_URL").pipe(
      Config.withDefault("https://api.coingecko.com/api/v3")
    )

    const get = <A, I>(path: string, schema: Schema.Schema<A, I>): Effect.Effect<A, ClientError> =>
      httpClient.get(`${baseUrl}${path}`).pipe(
        Effect.flatMap((response): Effect.Effect<A, ClientError> => {
          if (response.status === 429) {
            const retryAfter = response.headers["retry-after"]
            return Effect.fail(new RateLimitError({ retryAfter: retryAfter ? Number(retryAfter) : undefined }))
          }
          return response.json.pipe(
            Effect.flatMap((body) => Schema.decodeUnknown(schema)(body)),
            Effect.mapError((e) => e as ClientError)
          )
        }),
        Effect.catchAll((error): Effect.Effect<A, ClientError> => {
          if (error instanceof HttpClientError.ResponseError && error.response.status === 429) {
            const retryAfter = error.response.headers["retry-after"]
            return Effect.fail(new RateLimitError({ retryAfter: retryAfter ? Number(retryAfter) : undefined }))
          }
          return Effect.fail(error)
        })
      )

    return {
      getMarkets: get(
        "/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=100&page=1&sparkline=false",
        Schema.Array(CoinMarket)
      ) as Effect.Effect<ReadonlyArray<CoinMarket>, ClientError>,
      getCoinDetail: (id: string): Effect.Effect<CoinDetail, ClientError> =>
        get(
          `/coins/${id}?localization=false&tickers=false&market_data=false&community_data=false&developer_data=false`,
          CoinDetailApi
        ).pipe(
          Effect.map((raw): CoinDetail => ({
            id: raw.id,
            symbol: raw.symbol,
            name: raw.name,
            description: raw.description?.en ?? null,
            homepageUrl: raw.links?.homepage?.find((url) => url.length > 0) ?? null,
            categories: (raw.categories ?? []).filter((c): c is string => c !== null),
            marketCapRank: raw.marketCapRank ?? null
          }))
        ),
      getMarketChart: (
        id: string
      ): Effect.Effect<ReadonlyArray<{ timestamp: number; price: number }>, ClientError> =>
        get(
          `/coins/${id}/market_chart?vs_currency=usd&days=1`,
          Schema.Struct({ prices: Schema.Array(Schema.Tuple(Schema.Number, Schema.Number)) })
        ).pipe(
          Effect.map((result) => result.prices.map(([timestamp, price]) => ({ timestamp, price })))
        )
    }
  }),
  dependencies: [FetchHttpClient.layer]
}) {}
