---
name: tagged-errors
description: "Effect/TypeScript pattern for modeling business errors in the E channel with Schema.TaggedError, with optional HTTP status mapping via HttpApiSchema.annotations. Use whenever an Effect can fail for an identifiable business reason and you want exhaustive, serializable, tag-discriminated error handling instead of thrown exceptions."
---

## When to use

Every time an `Effect` can fail for an identifiable **business** reason (invalid credentials, validation failed, system failure). `throw new Error("...")` loses the type and forces `try/catch`; `Schema.TaggedError` gives you an error discriminated by `_tag`, exhaustive in `Effect.catchTags`, and serializable.

Combined with `HttpApiSchema.annotations({ status })`, the error also carries its HTTP status code — no more manual mapping in the transport layer.

## Procedure

1. Create a class that extends `Schema.TaggedError<Self>()`.
2. First argument = tag name (string literal, **identical** to the class name by convention).
3. Second argument = payload schema (extra fields available on the instance).
4. Third argument (optional) = annotations, including `HttpApiSchema.annotations({ status })` for the HTTP status code.
5. Categorize errors by **HTTP semantics**:
   - `4xx` business: business invariant violated (`InvalidCredentialsError` → 401)
   - `4xx` input: malformed input (`PasswordValidationError` → 400)
   - `5xx` infra: side-effect failure, not recoverable by the caller (`PasswordSystemError` → 500)
6. Throw with `yield* new MyError({ message: "..." })` inside an `Effect.gen`.

## Pitfalls

- **Don't reuse a generic error** like `AppError`. The whole point of the tag is exhaustiveness — `Effect.catchTags({ InvalidCredentialsError: ..., PasswordValidationError: ... })` only works if the errors are distinct.
- **Don't conflate business errors with `Cause.die`**. A programming bug (broken assertion, unexpected `null`) should *crash* via `Effect.die`, not become a 500 `TaggedError`. Keep 500 for I/O failures.
- **Minimal payload**. `message: Schema.String` is fine during development, but prefer typed fields (`userId: AuthId`, `field: Schema.Literal("email", "password")`) — the error becomes actionable on the client side without parsing the message.
- **`status` is only applied by the `HttpApi` runtime**. Throwing the same error from a worker / CLI won't produce an HTTP response — the status code is just documentation in that context.

## Example

```ts
import { Schema } from "effect"
import { HttpApiSchema } from "@effect/platform"

export class InvalidCredentialsError extends Schema.TaggedError<InvalidCredentialsError>()(
  "InvalidCredentialsError",
  { message: Schema.String },
  HttpApiSchema.annotations({ status: 401 })
) {}

export class PasswordValidationError extends Schema.TaggedError<PasswordValidationError>()(
  "PasswordValidationError",
  { message: Schema.String },
  HttpApiSchema.annotations({ status: 400 })
) {}

export class PasswordSystemError extends Schema.TaggedError<PasswordSystemError>()(
  "PasswordSystemError",
  { message: Schema.String },
  HttpApiSchema.annotations({ status: 500 })
) {}

// Usage
const login = (email: Email, hash: PasswordHash) =>
  Effect.gen(function* () {
    const user = yield* findUser(email)
    if (!user) {
      return yield* new InvalidCredentialsError({ message: "Unknown email" })
    }
    // ...
  })

// Exhaustive catch on the caller side
const handled = login(email, hash).pipe(
  Effect.catchTags({
    InvalidCredentialsError: (e) => Effect.succeed({ ok: false, reason: e._tag }),
    PasswordValidationError: (e) => Effect.succeed({ ok: false, reason: e._tag })
    // PasswordSystemError not caught → bubbles up to the global handler
  })
)
```

## Related

- branded-types — error payloads can (and should) use branded types
