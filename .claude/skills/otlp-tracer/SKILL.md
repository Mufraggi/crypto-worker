---
name: otlp-tracer
description: "Effect @effect/opentelemetry pattern for shipping Effect traces to an OTLP backend (BetterStack, Honeycomb, Tempo) with conditional activation via Config. Use when the app has Effect.withSpan spans worth collecting somewhere other than stdout, wired into the http-server-live layer chain."
---

## When to use

As soon as the app has spans worth collecting somewhere other than stdout: `Effect.withSpan` placed in the sql-repositorys, the effect-services, the HTTP handlers. Without a configured `Tracer`, those spans exist in the process memory but go nowhere.

Combined with http-server-live: `TracerLayer` is provided at the bottom of the chain. All upstream spans (DB, business, HTTP) are propagated automatically.

## Procedure

1. **Conditional layer**: `Layer.unwrapEffect` lets you decide at boot whether to enable tracing.
   - Read the API key via `Config.redacted` + `Config.option` → if absent, return `Layer.empty`.
   - Otherwise, build `OtlpTracer.layer({ url, headers, resource })`.
2. **Provide the tracer's internal deps** *nested*:
   - `OtlpSerialization.layerJson` — span serialization.
   - `NodeHttpClient.layerUndici` — HTTP client to push to the backend.
3. **Provide the config-reading deps** on the outer `Effect.gen`:
   - `PlatformConfigProvider.layerDotEnv(...)` — to read the `.env`.
   - `NodeContext.layer` — Node APIs needed by the config provider.
4. Export the `Layer` and wire it into `HttpLive` (or the worker's `Layer.launch`).

## Pitfalls

- **Token leak via `Redacted`**. Always `Redacted.value(...)` **inside** the layer builder, not higher up. Never log a `Redacted` (the wrapper masks it, the unwrap loses the guarantee).
- **Tracer absent → spans silently lost**. If the API key isn't set, `Layer.empty` is used: the `Effect.withSpan`s don't crash, but they emit nothing. That's deliberate (no-op in dev), provided you have a structured logging fallback.
- **Hardcoded `serviceName` / generic default**. `"my-service-name"` ends up in prod and overwrites other services in the OTel timeline. Always set `OTEL_SERVICE_NAME` per environment, and avoid a neutral default.
- **Backend-specific URL**. BetterStack has its endpoint, Honeycomb its own, etc. Move it to a `Config.string("OTEL_EXPORTER_OTLP_ENDPOINT")` if the app must be able to switch backends.
- **`PlatformConfigProvider.layerDotEnv`**. Reads the `.env` at the layer's `Effect.gen` startup; if the app already uses a different `ConfigProvider` (Vault, AWS Secrets), they need to be reconciled — otherwise you have two sources of truth for configs.
- **Auth headers**. `Bearer ${token}` is the BetterStack format; some backends (Honeycomb) want `x-honeycomb-team`. Check the provider's docs.
- **Tracing without propagation**. The tracer collects on the server side, but for an **outgoing** HTTP call to carry the `traceparent`, you need an instrumented `HttpClient` (http-api-handlers consumers must use the `HttpClient` provided by Effect, not raw `fetch`).
- **Cost in prod**. Tracing 100% of requests = huge volume. For non-trivial traffic, add `OtlpTracer.layer({ ..., sampler: ... })` or a sampler on the collector side.

## Example

```ts
import * as OtlpSerialization from "@effect/opentelemetry/OtlpSerialization"
import * as OtlpTracer from "@effect/opentelemetry/OtlpTracer"
import { PlatformConfigProvider } from "@effect/platform"
import { NodeContext, NodeHttpClient } from "@effect/platform-node"
import { Config, Effect, Layer, Option, Redacted } from "effect"
import * as path from "node:path"

export const TracerLayer = Layer.unwrapEffect(
  Effect.gen(function* () {
    const apiKey = yield* Config.redacted("BETTERSTACK_API_KEY").pipe(Config.option)

    // No key → no-op (dev without an OTLP backend)
    if (Option.isNone(apiKey)) {
      return Layer.empty
    }

    const serviceName = yield* Config.string("OTEL_SERVICE_NAME").pipe(
      Config.withDefault("my-service-name") // ⚠ too generic, override per env
    )

    return OtlpTracer.layer({
      url: "https://in-otel.logs.betterstack.com/v1/traces",
      headers: {
        Authorization: `Bearer ${Redacted.value(apiKey.value)}`
      },
      resource: { serviceName }
    }).pipe(
      Layer.provide(OtlpSerialization.layerJson),
      Layer.provide(NodeHttpClient.layerUndici)
    )
  }).pipe(
    // Deps of the outer Effect.gen (config reading)
    Effect.provide(PlatformConfigProvider.layerDotEnv(path.join(process.cwd(), ".env"))),
    Effect.provide(NodeContext.layer)
  )
)
```

## Related

- http-server-live — `TracerLayer` provided in the final chain
- sql-repository — the `Effect.withSpan`s that produce the spans
- effect-service — services that can also be instrumented
