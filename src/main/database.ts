import { app } from 'electron'
import SQLite from 'better-sqlite3'
import { eq, sql } from 'drizzle-orm'
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { join } from 'node:path'

import type { DatabaseStatus } from '../shared/database'
import * as schema from './db/schema'

let sqlite: SQLite.Database | undefined
let database: BetterSQLite3Database<typeof schema> | undefined

function getMigrationsPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'drizzle')
    : join(app.getAppPath(), 'drizzle')
}

export function initializeDatabase(): BetterSQLite3Database<typeof schema> {
  if (database) return database

  const databasePath = process.env.DB_FILE_NAME ?? join(app.getPath('userData'), 'app.sqlite')
  const sqliteClient = new SQLite(databasePath)

  sqliteClient.pragma('journal_mode = WAL')
  sqliteClient.pragma('foreign_keys = ON')

  const drizzleDatabase = drizzle({ client: sqliteClient, schema })
  migrate(drizzleDatabase, { migrationsFolder: getMigrationsPath() })

  sqlite = sqliteClient
  database = drizzleDatabase

  return database
}

export function getDatabaseStatus(): DatabaseStatus {
  initializeDatabase()
  const row = sqlite!.prepare('SELECT sqlite_version() AS version').get() as { version: string }

  return {
    connected: sqlite!.open,
    path: sqlite!.name,
    sqliteVersion: row.version
  }
}

export function getValue(key: string): string | null {
  const db = initializeDatabase()
  const row = db
    .select({ value: schema.appKv.value })
    .from(schema.appKv)
    .where(eq(schema.appKv.key, key))
    .get()

  return row?.value ?? null
}

export function setValue(key: string, value: string): void {
  const db = initializeDatabase()

  db.insert(schema.appKv)
    .values({ key, value })
    .onConflictDoUpdate({
      target: schema.appKv.key,
      set: {
        value,
        updatedAt: sql`CURRENT_TIMESTAMP`
      }
    })
    .run()
}

export function closeDatabase(): void {
  if (sqlite?.open) sqlite.close()
  sqlite = undefined
  database = undefined
}
