import { HttpClient, HttpClientError } from "@effect/platform"
import { Config, Context, Data, Effect, Layer, Schema } from "effect"
import { CoinDetail, CoinMarket } from "./CoinGeckoSchemas.js"

export class RateLimitError extends Data.TaggedError("RateLimitError")<{
  retryAfter: number | undefined
}> {}

// Shape of the CoinGeckoClient service
export interface CoinGeckoClientShape {
  readonly getMarkets: Effect.Effect<ReadonlyArray<CoinMarket>, HttpClientError.HttpClientError | RateLimitError>
  readonly getCoinDetail: (id: string) => Effect.Effect<CoinDetail, HttpClientError.HttpClientError | RateLimitError>
  readonly getMarketChart: (
    id: string
  ) => Effect.Effect<
    ReadonlyArray<{ timestamp: number; price: number }>,
    HttpClientError.HttpClientError | RateLimitError
  >
}

// Tag for the CoinGeckoClient service
export class CoinGeckoClient extends Context.Tag("CoinGeckoClient")<CoinGeckoClient, CoinGeckoClientShape>() {}

// Live implementation layer
export const CoinGeckoClientLive = Layer.effect(
  CoinGeckoClient,
  Effect.gen(function*() {
    const httpClient = yield* HttpClient.HttpClient
    const baseUrl = yield* Config.string("COINGECKO_BASE_URL").pipe(
      Config.withDefault("https://api.coingecko.com/api/v3")
    )

    const get = <A>(
      path: string,
      schema: Schema.Schema<A>
    ): Effect.Effect<A, HttpClientError.HttpClientError | RateLimitError> =>
      httpClient.get(`${baseUrl}${path}`).pipe(
        Effect.flatMap((response): Effect.Effect<A, HttpClientError.HttpClientError | RateLimitError> => {
          if (response.status === 429) {
            const retryAfter = response.headers["retry-after"]
            return Effect.fail(new RateLimitError({ retryAfter: retryAfter ? Number(retryAfter) : undefined }))
          }
          return response.json.pipe(
            Effect.flatMap((body) => Schema.decodeUnknown(schema)(body)),
            Effect.mapError((e) => e as HttpClientError.HttpClientError | RateLimitError)
          )
        }),
        Effect.catchAll((error): Effect.Effect<A, RateLimitError, never> => {
          if (
            HttpClientError.ResponseError && error instanceof HttpClientError.ResponseError &&
            error.response.status === 429
          ) {
            const retryAfter = error.response.headers["retry-after"]
            return Effect.fail(new RateLimitError({ retryAfter: retryAfter ? Number(retryAfter) : undefined }))
          }
          return Effect.die(error)
        })
      )

    return {
      getMarkets: get(
        "/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=100&page=1&sparkline=false",
        Schema.Array(CoinMarket)
      ),
      getCoinDetail: (id: string) =>
        get(
          `/coins/${id}?localization=false&tickers=false&market_data=false&community_data=false&developer_data=false`,
          CoinDetail
        ),
      getMarketChart: (id: string) =>
        get(
          `/coins/${id}/market_chart?vs_currency=usd&days=1`,
          Schema.Struct({ prices: Schema.Array(Schema.Tuple(Schema.Number, Schema.Number)) })
        ).pipe(
          Effect.map((result) => result.prices.map(([timestamp, price]) => ({ timestamp, price })))
        )
    }
  })
)
