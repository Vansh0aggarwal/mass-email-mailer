import mongoose from 'mongoose';
import { env } from './env.js';

let memoryServer: any = null;

function redactMongoUri(uri: string): string {
  return uri.replace(/\/\/[^@/]+@/, '//***:***@');
}

export async function connectDatabase(): Promise<typeof mongoose> {
  if (mongoose.connection.readyState === 1) {
    return mongoose;
  }

  // Attempt standard MongoDB connection first
  try {
    mongoose.set('strictQuery', true);

    let targetUri = env.MONGODB_URI;

    const isTest =
      env.NODE_ENV === 'test' || Boolean(process.env.VITEST);

    if (isTest && !process.env.MONGODB_URI_TEST) {
      const match = targetUri.match(
        /^(mongodb(?:\+srv)?:\/\/[^/?]+)(?:\/([^?]*))?(\?.*)?$/i
      );

      if (match) {
        const [, base, existingDb, query = ''] = match;

        const dbName = `${existingDb?.trim() || 'swaniki_radar'}_test`;

        targetUri = `${base}/${dbName}${query}`;
      }
    }

    await mongoose.connect(targetUri, {
      serverSelectionTimeoutMS: 5000,
      connectTimeoutMS: 5000,
      socketTimeoutMS: 30000,

      // Connection pool limits for the Render Free instance.
      maxPoolSize: 5,
      minPoolSize: 1,

      // Keep MongoDB connections alive.
      heartbeatFrequencyMS: 30000,
    });

    console.log(
      `[Database] Connected to external MongoDB at ${redactMongoUri(targetUri)}`
    );

    return mongoose;

  } catch (err: any) {

    // Never start an in-memory database in production.
    if (env.NODE_ENV === 'production') {
      console.error(
        '[Database] Failed to connect to MongoDB in production mode:',
        err.message
      );

      throw err;
    }

    // Development and testing fallback.
    console.warn(
      `[Database] Could not connect to external MongoDB (${err.message}).`
    );

    console.log(
      '[Database] Starting embedded MongoMemoryServer for development/testing...'
    );

    try {
      // Use a computed package name so TypeScript does not
      // require this development-only package during compilation.
      const packageName = 'mongodb-memory-server';

      const { MongoMemoryServer } = await import(packageName);

      memoryServer = await MongoMemoryServer.create();

      const memUri = memoryServer.getUri();

      await mongoose.connect(memUri);

      console.log(
        `[Database] Connected to embedded in-memory MongoDB at ${memUri}`
      );

      return mongoose;

    } catch (memErr: any) {
      console.error(
        '[Database] Failed to initialize embedded MongoMemoryServer:',
        memErr.message
      );

      throw memErr;
    }
  }
}

export async function disconnectDatabase(): Promise<void> {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();

    console.log('[Database] Disconnected from MongoDB');
  }

  if (memoryServer) {
    await memoryServer.stop();

    memoryServer = null;

    console.log('[Database] Stopped embedded MongoMemoryServer');
  }
}