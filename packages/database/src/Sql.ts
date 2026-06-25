import { PlatformConfigProvider } from "@effect/platform"
import { NodeContext } from "@effect/platform-node"
import { PgClient } from "@effect/sql-pg"
import { Config, Duration, Effect, identity, Layer, Redacted, String } from "effect"
import * as path from "node:path"
import pgTypes from "pg-types"

// On garde dates/timestamps en string (parsing applicatif via Schema) au lieu de
// laisser node-postgres construire des objets Date.
pgTypes.setTypeParser(1082, identity) // DATE
pgTypes.setTypeParser(1114, identity) // TIMESTAMP WITHOUT TIME ZONE
pgTypes.setTypeParser(1184, identity) // TIMESTAMP WITH TIME ZONE

/**
 * Layer de connexion PostgreSQL partagé.
 *
 * Conventions associées :
 * - `src/models/<Name>Model.ts` : `class XModel extends Model.Class<XModel>("XModel")({
 *     id: Model.Generated(XId), ..., createdAt: Model.Generated(Timestamp) }) {}`
 * - `src/repository/<Name>Repository.ts` : `Effect.Service` basé sur
 *   `Model.makeRepository(XModel, { tableName, idColumn })`, dépend de `PgLive`.
 */
export const PgLive = Layer.unwrapEffect(
  Effect.gen(function*() {
    const database = yield* Config.string("DB_HOST")
    const username = yield* Config.string("DB_USER")
    const port = yield* Config.string("DB_PORT")
    const password = yield* Config.string("DB_PWD")
    const dbName = yield* Config.string("DB_NAME")
    // Taille du pool configurable (défaut 10) : permet de dimensionner par service via l'env
    // sans recompiler — un worker a souvent besoin d'un pool plus large que l'API.
    const poolSize = yield* Config.integer("DB_POOL_SIZE").pipe(Config.withDefault(10))
    // Timeout d'acquisition d'une connexion (défaut 10s) : en cas de famine du pool, on échoue
    // vite et proprement (SqlError) au lieu d'attendre indéfiniment.
    const acquireTimeoutMs = yield* Config.integer("DB_POOL_ACQUIRE_TIMEOUT_MS").pipe(Config.withDefault(10000))

    const url = `postgres://${username}:${password}@${database}:${port}/${dbName}`
    const ssl = false

    return PgClient.layer({
      url: Redacted.make(url),
      ssl,
      maxConnections: poolSize,
      connectTimeout: Duration.millis(acquireTimeoutMs),
      transformQueryNames: String.camelToSnake,
      transformResultNames: String.snakeToCamel,
      types: pgTypes
    })
  })
).pipe(
  Layer.provide(PlatformConfigProvider.layerDotEnv(path.join(process.cwd(), ".env"))),
  Layer.provide(NodeContext.layer)
)
