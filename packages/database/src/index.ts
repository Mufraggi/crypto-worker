/**
 * Creates the CoinGecko demo tables at application startup.
 *
 * Called once when the worker process starts, before any workflow layers
 * are launched.
 */
export * as CoinGeckoMigrations from "./CoinGeckoMigrations.js"

/**
 * Layer de connexion PostgreSQL partagé.
 *
 * Conventions associées :
 * - `src/models/<Name>Model.ts` : `class XModel extends Model.Class<XModel>("XModel")({
 *     id: Model.Generated(XId), ..., createdAt: Model.Generated(Timestamp) }) {}`
 * - `src/repository/<Name>Repository.ts` : `Effect.Service` basé sur
 *   `Model.makeRepository(XModel, { tableName, idColumn })`, dépend de `PgLive`.
 */
export * as Sql from "./Sql.js"
