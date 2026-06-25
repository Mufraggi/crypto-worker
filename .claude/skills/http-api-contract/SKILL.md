---
name: http-api-contract
description: "Effect @effect/platform pattern for declaring the HTTP endpoints of a group (verb, path, payload, success, errors, middleware) with HttpApiGroup/HttpApiEndpoint — contract only, no implementation. Use every time a new endpoint is added; it is the shared source of truth for the server runtime, the typed client, and OpenAPI."
---

## When to use

**Every time** a new endpoint is added. The contract is the **shared source of truth**:
- consumed by the server runtime (http-api-handlers), which forces the implementation to respect it,
- consumed by the client (`HttpApiClient.make`) to generate a typed client,
- consumed by OpenAPI / Swagger via `HttpApiSwagger`.

If the contract changes, the compiler breaks on the server **and** the client side. It's the right place to anchor breaking changes.

## Procedure

1. Create a class `class XxxGroup extends HttpApiGroup.make("@Group/Xxx") ... {}`. The tag string identifies the group — reused by http-api-handlers.
2. Chain `.add(HttpApiEndpoint.<verb>(name, path)...)` for each route.
   - `name` = logical identifier, must match the `.handle("name", ...)` in the live.
   - `path` = URL with `:id` params (Express-like).
3. For each endpoint, declare:
   - `.setPayload(Schema)` — body (POST/PATCH).
   - `.setPath(Schema.Struct({ id: BrandedId }))` — URL params, **typed with branded types** (see branded-types).
   - `.setUrlParams(Schema)` — query string.
   - `.addSuccess(Schema)` — 2xx response.
   - `.addError(TaggedError)` — once per error variant (see tagged-errors).
   - `.middleware(XxxMiddleware)` — attaches an http-api-middleware; adds its `provides` to the context and its `failure` to the error channel.
4. `.prefix("/segment")` at the group level for the shared prefix.
5. Put **nothing** in this class but declarations. No logic, no DB fetch.

## Pitfalls

- **Exhaustive `addError`**. If an error can leak out of a handler and isn't declared, either the compiler complains (non-empty `E` channel), or it ends up as a silent 500. Always keep contract ↔ handler in sync.
- **`HttpApiError.InternalServerError`**. Add it as soon as a handler can `Effect.orDie` or a dependency can panic (DB down). It's the typed catch-all 500.
- **Raw `string` path params**. `setPath(Schema.Struct({ id: Schema.String }))` compiles but loses the semantics. Always use the corresponding branded ID.
- **The endpoint's `name` and the `handle()` must match exactly**. No compile-time check — a typo = "handler not found" at boot. Convention: copy-paste the contract's name into the handler.
- **Errors already added by the middleware**. If `RefreshJwtMiddleware` declares `failure: Unauthorized`, the caller does NOT need to re-`.addError(Unauthorized)` on every endpoint that uses it. The middleware injects its failure into the channel automatically.
- **Order of `.addError`**. None enforced, but grouping by "domain" (auth, validation, infra) helps readability when the list gets to 10 lines.
- **`.prefix` after all the `.add`s**. The reverse compiles but the prefix only applies to endpoints added *after* it — a subtle bug.

## Example

```ts
import { HttpApiEndpoint, HttpApiError, HttpApiGroup } from "@effect/platform"
import { Schema } from "effect"
import { LoginInput, PasswordMismatchError } from "@template/auth/domain/input/LoginInput"
import { InvalidCredentialsError, PasswordSystemError } from "@template/auth/domain/bcryptError/BcryptError"
import { RateLimitExceeded } from "@template/auth/domain/rateLimit/RateLimitError"
import { TokenGenerationError } from "@template/auth/domain/JwtToken"
import { UserEmailNotFound } from "@template/domain/user/UserError"
import { AccountCreationEmailId } from "@template/domain/invation/InvitationType"
import { Email } from "@template/auth/domain/AuthType"
import { RefreshJwtMiddleware } from "./middlewares/RefreshTokenMiddleware.js"

export class HttpApiGroupAuth extends HttpApiGroup.make("@Group/Auth")
  .add(
    HttpApiEndpoint.post("login", "/login")
      .setPayload(LoginInput)
      .addSuccess(Schema.Struct({ success: Schema.Boolean }))
      .addError(InvalidCredentialsError)
      .addError(PasswordSystemError)
      .addError(UserEmailNotFound)
      .addError(TokenGenerationError)
      .addError(RateLimitExceeded)
      .addError(HttpApiError.InternalServerError)
  )
  .add(
    HttpApiEndpoint.post("refresh-token", "/refresh-token")
      .addSuccess(Schema.Struct({ success: Schema.Boolean }))
      .addError(InvalidCredentialsError)
      .addError(TokenGenerationError)
      .middleware(RefreshJwtMiddleware) // → adds Unauthorized to the error channel
  )
  .add(
    HttpApiEndpoint.get("validateFirstPasswordLink", "/first-password-setup/:id/validate")
      .setPath(Schema.Struct({ id: AccountCreationEmailId })) // branded
      .addSuccess(Schema.Struct({ valid: Schema.Literal(true), email: Email }))
  )
  .prefix("/auth")
{}
```

## Related

- http-api-handlers — the implementation that honors this contract
- http-api-middleware — attached via `.middleware(...)`
- tagged-errors — every `.addError(...)` is a `TaggedError`
- branded-types — `setPath` must use branded IDs
