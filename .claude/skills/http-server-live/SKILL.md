---
name: http-server-live
description: "Effect @effect/platform pattern for wiring the HTTP runtime: composing all Live groups into ApiLive, global middlewares (CORS, logger, Swagger/OpenAPI), the Node server, and cross-cutting base layers (Postgres, cluster, OTLP tracer), with correct Layer.provide ordering. Use once per application as the terminal layer launched in main."
---

## When to use

Once per application. It's the **terminal layer** that assembles:
- the Live groups from http-api-handlers into an `ApiLive`,
- the global middlewares (CORS, HTTP logger, swagger),
- the concrete Node server,
- the cross-cutting **base layers** (Postgres, Effect cluster, OTLP tracer).

The order of `Layer.provide`s is not innocent — general rule: what *consumes* goes on top, what *provides* underneath.

## Procedure

1. **Compose `ApiLive`**: `Layer.provide(HttpApiBuilder.api(Api), [GroupLive1(api), GroupLive2(api), ...])`.
   - `HttpApiBuilder.api(Api)` = turns the contract into a consumable layer.
   - Each `XxxLive(api)` is called with the contract root — that's where the `ApiType` exported by http-api-root is used.
2. **Conditional layers**: `Layer.unwrapEffect(Effect.gen(...))` lets you pick a layer at boot based on `Config`. Example: Swagger only outside production.
3. **Compose `HttpLive`**: start with `HttpApiBuilder.serve(HttpMiddleware.logger)` then stack the `.pipe(Layer.provide(...))`s:
   - `SwaggerLive`
   - `HttpApiBuilder.middlewareOpenApi()`
   - `ApiLive`
   - `HttpApiBuilder.middlewareCors({ ... })`
   - `HttpServer.withLogAddress` (logs the URL at startup)
   - `NodeHttpServer.layer(createServer, { port })`
   - base layers: `PgLive`, `ClusterLayer`, `TracerLayer`
4. **Strict CORS**: `credentials: true` requires explicit origins (no `*`). Headers must be listed explicitly, including `traceparent` if doing distributed tracing.
5. Export `HttpLive`; it will be started via `Layer.launch(HttpLive)` in `main.ts`.

## Pitfalls

- **`Layer.provide` order**. Mental model: the chain reads top to bottom, but dependencies flow bottom to top. If `ApiLive` consumes `PgLive`, then `PgLive` must be `.provide`d **after** (lower in the chain than) `ApiLive`. Classic mistake: reordering everything and breaking a silent dependency.
- **`Layer.provide` shadowing**. If the same dep is provided twice (e.g. two versions of `PgLive`), the one **closest to the consumer** wins. Subtle source of "works in dev, not in prod".
- **CORS `credentials: true` + origin wildcard**. Forbidden by the standard; browsers silently refuse. Always list the origins.
- **Hardcoded port**. `{ port: 80 }` prevents local dev without `sudo` and complicates parallel testing. Better: `Config.integer("PORT").pipe(Config.withDefault(3000))`, then injected.
- **Hardcoded origins**. Same — every environment (dev/preprod/prod) should come from a `Config.array("ALLOWED_ORIGINS")` rather than a literal array.
- **Swagger in production**. Exposing the doc in prod = attack surface (endpoint enumeration, even payloads). The `Layer.unwrapEffect` + `env === "production"` check pattern is correct; just verify the `ENV` variable is actually set in prod (otherwise default `development` → Swagger live).
- **`HttpMiddleware.logger`**. Logs every request to stdout — noisy in prod. Often to be replaced by a structured tracing middleware once OTel is wired up.
- **Missing layer** = compile error (non-`never` `R` channel). Good news: impossible to boot with an unresolved service. Bad news: the error message cites the full `R`, sometimes 50+ lines — read it looking for the missing service name.

## Example

```ts
import { HttpApiBuilder, HttpApiSwagger, HttpMiddleware, HttpServer } from "@effect/platform"
import { NodeHttpServer } from "@effect/platform-node"
import { Config, Effect, Layer } from "effect"
import { createServer } from "http"
import { PgLive } from "@template/database/Sql"
import { ClusterLayer } from "@template/workflow/WorkerClient"
import { TracerLayer } from "./Telemetry.js"
import { Api } from "./Api.js"
import { HttpApiGroupAuthLive } from "./HttpGroupAuth.js"
import { HttpApiGroupUsersLive } from "./users/HttpGroup.js"
import { getHealthGroupLive } from "./Health/HttpApiGroup.js"
// ... other Lives

const api = Api

// 1. Aggregating the Live groups
const ApiLive = Layer.provide(HttpApiBuilder.api(Api), [
  getHealthGroupLive(api),
  HttpApiGroupAuthLive(api),
  HttpApiGroupUsersLive(api)
  // ... one per group in the contract
])

// 2. Conditional Swagger
const SwaggerLive = Layer.unwrapEffect(
  Effect.gen(function* () {
    const env = yield* Config.string("ENV").pipe(Config.withDefault("development"))
    return env === "production" ? Layer.empty : HttpApiSwagger.layer()
  })
)

// 3. Final assembly
export const HttpLive = HttpApiBuilder.serve(HttpMiddleware.logger).pipe(
  Layer.provide(SwaggerLive),
  Layer.provide(HttpApiBuilder.middlewareOpenApi()),
  Layer.provide(ApiLive),
  Layer.provide(
    HttpApiBuilder.middlewareCors({
      allowedOrigins: ["http://localhost:3000", "https://app.example.com"],
      allowedMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
      allowedHeaders: ["Content-Type", "Authorization", "traceparent", "tracestate", "b3"],
      credentials: true
    })
  ),
  HttpServer.withLogAddress,
  Layer.provide(NodeHttpServer.layer(createServer, { port: 80 })),
  Layer.provide(PgLive),
  Layer.provide(ClusterLayer),
  Layer.provide(TracerLayer)
)
```

## Related

- http-api-root — provides the `Api` and `ApiType` consumed here
- http-api-handlers — each `XxxLive(api)` added to `ApiLive`
- otlp-tracer — `TracerLayer` provided here
