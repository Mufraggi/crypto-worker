/**
 * Charge la configuration depuis un fichier `.env` à la racine du process.
 * Provisionné par `NodeContext.layer` (accès FileSystem/Path).
 */
export * as Config from "./Config.js"

/**
 * Type timestamp partagé pour les colonnes `created_at` / `updated_at`.
 */
export * as Timestamp from "./Timestamp.js"

/**
 * Service de génération d'UUID, injectable via Effect.
 */
export * as Uuid from "./Uuid.js"
