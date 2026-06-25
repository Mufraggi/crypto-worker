---
name: http-api-handlers
description: "Effect @effect/platform pattern for implementing the handlers (Live) of an HTTP group via HttpApiBuilder.group — wiring commands/queries, cookies, client IP, rate limiting, and fire-and-forget workflows, then provisioning the layers. Use once the http-api-contract is defined to provide the per-group implementation."
---

## When to use

Once the http-api-contract is defined, the `Live` provides the implementation. The contract compile-checks the signature; the live wires the effect-services (commands, queries, workflows) to the endpoints.

Recurring structure: **one file per group**, exporting a factory `(api) => HttpApiBuilder.group(...).pipe(Layer.provide([...]))`.

## Procedure

1. Export a **factory**: `export const HttpApiGroupXxxLive = (api: ApiType) => HttpApiBuilder.group(api, "@Group/Xxx", (handlers) => ...)`.
   - The tag string must match the contract.
2. Inside the callback, open an `Effect.gen(function*() { ... })`.
3. **Yield everything at the top**: config, business services (commands/queries), technical services (rate limiter, IP extractor). These yields are **singletons** per layer instantiation, not per request.
4. `return handlers.handle("name", (req) => ...).handle("name2", ...)` — fluent chain.
5. Inside each handler:
   - `req.payload`, `req.path`, `req.urlParams` are typed by the contract.
   - For middleware-provided values: `const user = yield* CurrentUserLicence` — type pulled from the http-api-middleware's `provides`.
   - For raw access: `yield* HttpServerRequest.HttpServerRequest`.
   - For cookies: `yield* HttpApiBuilder.securitySetCookie(security, Redacted.make(token), opts)`.
6. **Fire-and-forget workflows**: `yield* XxxWorkflow.execute(input, { discard: true })` — the HTTP request returns without waiting for the workflow.
7. `.pipe(Layer.provide([...all layers used...]))` — this is where every service is wired up.

## Pitfalls

- **Yield at the top vs. inside the handler**. Anything yielded before `return handlers` = **singleton**. If you yield something dependent on `req.payload` at the top, it's wrong. Conversely, yielding a stateless service inside each handler = needless re-resolution on every request.
- **Incomplete `Layer.provide`**. If you add a new service inside the `Effect.gen` and forget to add it to the `Layer.provide([...])` array, the code compiles (the type shows up in the `R` channel) but boot fails with "Service not found". Convention: one yield = one entry in `provide`.
- **Cookies and `Redacted.make("")` for logout**. The immediate-expiration pattern (`expires: new Date(0), maxAge: 0`) must be applied to **every** session cookie, otherwise one is left and the user stays partially logged in. Make sure to cover access **and** refresh.
- **`extractClientIp` behind a proxy**. Only works if the server trusts the `X-Forwarded-For` headers. Otherwise the rate limiter's IP = the load balancer's. To validate on the infra side (cf. Express/Fastify `trust proxy` config).
- **Type literal in `return`**. `return { success: true }` types as `{ success: boolean }` — it doesn't match a `addSuccess(Schema.Literal(true))`. Always `return { success: true } as const` when the contract expects a literal.
- **`Effect.all` for parallel cookies**. The `securitySetCookie`s don't "combine" in a plain sequence — use `Effect.all([cookie1, cookie2])` as in the example.
- **Unused path param is still typo-safe**. `req.path.id` is typed by the contract — if the contract renames the param, this breaks here. That's intentional, but it means a rename is a cross-file refactor.

## Example

```ts
import { HttpApiBuilder, HttpServerRequest } from "@effect/platform"
import { Config, Effect, Layer, Redacted } from "effect"
import type { ApiType } from "./Api.js"
import { LoginCommand, LoginCommandLayer } from "../commands/LoginCommand"
import { RateLimiterService } from "../services/RateLimiterService"
import { loadAuthRateLimitRules } from "../domain/rateLimit/RateLimitConfig"
import { accessTokenSecurity, refreshTokenSecurity } from "./security"
import { extractClientIp } from "./utils/extractClientIp.js"

export const HttpApiGroupAuthLive = (api: ApiType) =>
  HttpApiBuilder.group(api, "@Group/Auth", (handlers) =>
    Effect.gen(function* () {
      // 1. Yield singletons (config, services)
      const baseUrl = yield* Config.string("BASE_URL_VALIDATION_EMAIL")
      const rateLimiter = yield* RateLimiterService
      const rules = yield* loadAuthRateLimitRules
      const loginCommand = yield* LoginCommand

      // 2. Wire the handlers
      return handlers
        .handle("login", (req) =>
          Effect.gen(function* () {
            const httpRequest = yield* HttpServerRequest.HttpServerRequest
            yield* rateLimiter.check({
              endpoint: "login",
              ip: extractClientIp(httpRequest),
              identifier: req.payload.email,
              rule: rules.login
            })
            const { accessToken, refreshToken } = yield* loginCommand.run(req.payload)
            yield* Effect.all([
              HttpApiBuilder.securitySetCookie(
                refreshTokenSecurity,
                Redacted.make(refreshToken),
                { httpOnly: true, path: "/" }
              ),
              HttpApiBuilder.securitySetCookie(
                accessTokenSecurity,
                Redacted.make(accessToken),
                { httpOnly: true, path: "/" }
              )
            ])
            return { success: true }
          })
        )
        .handle("logout", () =>
          Effect.all([
            HttpApiBuilder.securitySetCookie(refreshTokenSecurity, Redacted.make(""), {
              path: "/", expires: new Date(0), maxAge: 0, httpOnly: true
            }),
            HttpApiBuilder.securitySetCookie(accessTokenSecurity, Redacted.make(""), {
              path: "/", expires: new Date(0), maxAge: 0, httpOnly: true
            })
          ]).pipe(Effect.as({ success: true }))
        )
    })
  ).pipe(
    // 3. Wire all layers used in handlers
    Layer.provide([
      RateLimiterService.Default,
      LoginCommandLayer
      // ... one per service yielded above
    ])
  )
```

## Related

- http-api-contract — the contract whose implementation this is
- http-api-middleware — provides `CurrentUser*` to the context
- effect-service — the commands/queries yielded at the top
