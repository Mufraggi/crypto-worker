import { Schema } from "effect"

/** Type timestamp partagé pour les colonnes `created_at` / `updated_at`. */
export const Timestamp = Schema.Date
export type Timestamp = Schema.Date
