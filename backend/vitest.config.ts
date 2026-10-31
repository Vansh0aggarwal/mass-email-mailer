import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import dotenv from 'dotenv';
import { defineConfig } from 'vitest/config';

/**
 * Tests must never write to the application database. Suites clean up with
 * `deleteMany`, and an unscoped cleanup once removed every campaign recipient
 * from the developer's workspace. Point tests at a sibling `<db>_test`
 * database unless MONGODB_URI_TEST explicitly selects one.
 */
function resolveTestMongoUri(): string | undefined {
  if (process.env.MONGODB_URI_TEST) return process.env.MONGODB_URI_TEST;

  let uri = process.env.MONGODB_URI;
  if (!uri) {
    try {
      const parsed = dotenv.parse(readFileSync(resolve(process.cwd(), '.env')));
      uri = parsed.MONGODB_URI;
    } catch {
      return undefined;
    }
  }
  if (!uri) return undefined;

  // mongodb[+srv]://[user:pass@]host[/dbname][?options] — keep credentials and
  // options intact, only replace the database name.
  const match = uri.match(/^(mongodb(?:\+srv)?:\/\/[^/?]+)(?:\/([^?]*))?(\?.*)?$/);
  if (!match) return undefined;

  const [, base, existingDb, query = ''] = match;
  const dbName = `${existingDb?.trim() || 'swaniki_radar'}_test`;
  return `${base}/${dbName}${query}`;
}

const testMongoUri = resolveTestMongoUri();
if (testMongoUri) {
  process.env.MONGODB_URI = testMongoUri;
}

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    testTimeout: 30000,
    hookTimeout: 60000,
    fileParallelism: false,
  },
});
