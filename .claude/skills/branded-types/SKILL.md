---
name: branded-types
description: "Effect/TypeScript pattern for nominal typing with Schema.brand. Use when a function takes multiple parameters of the same primitive type (string/number/boolean) that could be swapped, or when a primitive carries a business rule (email, UUID, password hash) that the `string` type can't express."
---

## When to use

As soon as a signature looks like `(a: string, b: string)` or `(id: string, userId: string)`. The compiler can't prevent swapping the arguments → silent bug.

Also: as soon as a primitive carries a **business rule** (a valid email, a UUID, a password hash). The `string` type lies — it accepts anything.

## Procedure

1. Identify the primitive that carries domain meaning.
2. Define an Effect schema with runtime validation + `Schema.brand`.
3. Export **the schema and the type under the same name** (companion pattern) — `typeof X.Type` extracts the branded type.
4. Replace `string` / `number` / `boolean` with the branded type in signatures.
5. At the boundaries (HTTP, DB), go through `Schema.decode` to get a branded instance out of a raw primitive.

## Pitfalls

- **The brand is erased at runtime**. Casting via `as Email` disables the safety. Always decode via `Schema.decode` / `decodeUnknown`.
- **`Type` vs `Encoded` confusion**. `typeof X.Type` = domain side (branded), `typeof X.Encoded` = serialization side (primitive). Use `Encoded` for DTO/DB, `Type` for the business logic.
- **Branding a boolean** (`IsActive`) is useful for signature clarity but adds no runtime validation — treat it as typed documentation, not a guarantee.
- **Brand without validation** (`Schema.String.pipe(Schema.brand("Foo"))` with no constraint) = just a nominal type. Fine if the value is already validated upstream; otherwise add `pattern`, `maxLength`, etc. before the brand.

## Example

```ts
import { Schema } from "effect"

export const AuthId = Schema.UUID.pipe(Schema.brand("AuthId"))
export type AuthId = typeof AuthId.Type

export const Email = Schema.String.pipe(
  Schema.pattern(/^[^\s@]+@[^\s@]+\.[^\s@]+$/),
  Schema.maxLength(255)
).pipe(Schema.brand("Email"))
export type Email = typeof Email.Type

export const PasswordHash = Schema.String.pipe(
  Schema.maxLength(255)
).pipe(Schema.brand("PasswordHash"))
export type PasswordHash = typeof PasswordHash.Type

export const IsActive = Schema.Boolean.pipe(Schema.brand("IsActive"))
export type IsActive = typeof IsActive.Type

// Usage
declare const login: (email: Email, hash: PasswordHash) => void

const raw = "user@example.com"
// login(raw, raw)                  // ❌ doesn't compile
const email = Schema.decodeSync(Email)(raw)
// login(email, email)              // ❌ doesn't compile (PasswordHash expected)
```

## Related

- tagged-errors — decoding failures are also modeled via Schema
