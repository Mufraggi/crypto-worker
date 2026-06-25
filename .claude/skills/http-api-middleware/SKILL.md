---
name: http-api-middleware
description: "Effect @effect/platform pattern for HTTP middleware that extracts a token (cookie/header), validates it, loads the user, and provides a typed context to handlers via HttpApiMiddleware.Tag. Use for cross-cutting auth/identity logic that runs before a handler, enriches context (current user, tenant, role), and can short-circuit with 401/403."
---

## When to use

For any logic that:
- runs **before** a handler,
- reads a "cross-cutting" input (cookie, header, global query),
- enriches the context (current user, tenant, role),
- can short-circuit with an error (401, 403).

Effect HTTP pattern: **separate contract and live**, same as http-api-contract / http-api-handlers. The contract declares what the middleware provides; the live implements it.

## Procedure

### Contract (file `XxxMiddleware.ts` on the domain side)

1. Declare the "provided" type: a `Context.Tag` class that carries the injected data (`CurrentUserLicence`, etc.). This is what we'll yield in the handler.
2. Declare the middleware: `class XxxMiddleware extends HttpApiMiddleware.Tag<Self>()("XxxMiddleware", { ... })`.
3. Fill in:
   - `failure` — `TaggedError` thrown if the check fails (`Unauthorized`).
   - `provides` — the tag of the injected context (step 1).
   - `security` — how to extract the token: `HttpApiSecurity.apiKey({ key, in: "cookie" | "header" })`, `bearer`, etc. The record key (`myBearer` in the example) is the **scheme name**; the live must implement it under that name.

### Live (file `XxxMiddlewareLive.ts` on the infra side)

1. `Layer.effect(MiddlewareTag, Effect.gen(...))`.
2. Yield the required services (JWT, user repo).
3. Return a record `{ [schemeName]: (token) => Effect.gen(...) }`. The function receives the extracted token and returns the `provides`.
4. **Map every error to `failure`** via `Effect.catchAll(() => Effect.fail(new Unauthorized()))` — do NOT leak the auth failure detail to the client.
5. `.pipe(Layer.provide(...))` to wire up the internal deps.

## Pitfalls

- **`Effect.catchAll(() => Unauthorized)` hides the root cause**. Good for the client, **bad for debugging**. Add `Effect.tapError((e) => Effect.logError("auth failed", e))` before the catchAll — otherwise a misconfigured JWT looks like an expired token in the logs.
- **Scheme name ≠ docstring**. The `myBearer` key in `security: { myBearer: ... }` must be identical on the contract and live sides. Frequent bug at refactor time.
- **Cookie name ≠ securitySetCookie**. The contract's `key: "accessToken"` must match `accessTokenSecurity` on the `securitySetCookie` side. Otherwise the cookie is set but never read.
- **`provides` not a `Tag`**. `provides` must be a `Context.Tag` class. A raw `Schema.Struct` doesn't work — wrap it in a class (`class CurrentUserLicence extends Context.Tag(...)` or via `Schema.TaggedClass`).
- **Middleware that throws internally**. If the middleware does an `Effect.die` (uncaught defect), it **bypasses** the `catchAll` → 500 instead of 401. Important for programming bugs: that's the desired behavior (a bug isn't an auth defect) — but it means you should test that `findLicenceUserByUserId` doesn't die too easily.
- **No business logic**. A middleware should just authenticate/identify. Loading 6 joins to provide a full "current user" = penalty on **every** request. Keep `provides` minimal (id, role) and let the handler load what it needs.
- **`Layer.provide` of the live**. The live consumes `JwtService`, `AuthRepository`, etc. These deps must be provided to the layer, otherwise "Service not found" at boot.

## Example

### Contract

```ts
import { HttpApiMiddleware, HttpApiSecurity } from "@effect/platform"
import { Context, Schema } from "effect"
import { UserId } from "../../domain/account/AccountTypes.js"
import { LicenceId, LicencePremiumStatus } from "../../domain/licenceBrands.js"
import { Unauthorized } from "./RefreshTokenMiddleware.js"

// 1. What will be injected into the handler's context
export class UserLicenceJwtToken extends Schema.Class<UserLicenceJwtToken>("UserLicenceJwtToken")({
  id: UserId,
  licenceId: LicenceId,
  premiumStatus: LicencePremiumStatus
}) {}

export class CurrentUserLicence extends Context.Tag("CurrentUserLicence")<
  CurrentUserLicence,
  UserLicenceJwtToken
>() {}

// 2. The middleware
export class UserLicenceMiddleware extends HttpApiMiddleware.Tag<UserLicenceMiddleware>()(
  "UserLicenceMiddleware",
  {
    failure: Unauthorized,
    provides: CurrentUserLicence,
    security: {
      myBearer: HttpApiSecurity.apiKey({
        key: "accessToken",
        in: "cookie"
      })
    }
  }
) {}
```

### Live

```ts
import { Effect, Layer, Option, Redacted } from "effect"
import { Unauthorized } from "../../contract/middlewares/RefreshTokenMiddleware.js"
import { UserLicenceJwtToken, UserLicenceMiddleware } from "../../contract/middlewares/UserMiddleware.js"
import { AuthRepository, AuthRepositoryLayer } from "../../database/repository/AuthRepository.js"
import { accessTokenFromString } from "../../domain/JwtToken.js"
import { JwtService } from "../../services/JwtService.js"

export const UserLicenceMiddlewareLive = Layer.effect(
  UserLicenceMiddleware,
  Effect.gen(function* () {
    const jwtService = yield* JwtService
    const authRepository = yield* AuthRepository

    return {
      // Must match the contract's scheme name
      myBearer: (bearerToken) =>
        Effect.gen(function* () {
          const token = yield* accessTokenFromString(Redacted.value(bearerToken))
          const jwtPayload = yield* jwtService.verifyAccessToken(token)
          const userOpt = yield* authRepository.findLicenceUserByUserId(jwtPayload.userId)
          const user = yield* Option.match(userOpt, {
            onNone: () => Effect.fail(new Unauthorized()),
            onSome: Effect.succeed
          })
          return new UserLicenceJwtToken({
            id: user.id,
            licenceId: user.licenceId,
            premiumStatus: user.premiumStatus
          })
        }).pipe(
          Effect.tapError((e) => Effect.logError("UserLicenceMiddleware: auth failed", e)),
          Effect.catchAll(() => Effect.fail(new Unauthorized()))
        )
    }
  })
).pipe(
  Layer.provide(JwtService.Default),
  Layer.provide(AuthRepositoryLayer)
)
```

## Related

- http-api-contract — attaches the middleware via `.middleware(...)`
- http-api-handlers — consumes the `provides` via `yield* CurrentUserLicence`
- tagged-errors — `Unauthorized` is a `TaggedError`
- sql-repository — loading the user from the token
