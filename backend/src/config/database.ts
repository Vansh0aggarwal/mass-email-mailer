import mongoose from 'mongoose';
import { env } from './env.js';

let memoryServer: any = null;

function redactMongoUri(uri: string): string {
  return uri.replace(/\/\/[^@/]*@/, '//***:***@');
}

export async function connectDatabase(): Promise<typeof mongoose> {
  if (mongoose.connection.readyState === 1) {
    return mongoose;
  }

  // Attempt standard connection first
  try {
    mongoose.set('strictQuery', true);
    await mongoose.connect(env.MONGODB_URI, {
      serverSelectionTimeoutMS: 5000,
      connectTimeoutMS: 5000,
      socketTimeoutMS: 30000,
      // Explicit connection pool bounds. On a 512 MB server each idle
      // connection consumes ~1-2 MB. Five connections is sufficient for
      // normal API concurrency while a campaign scheduler runs.
      maxPoolSize: 5,
      minPoolSize: 1,
      // Heartbeat keeps the connection alive through NAT timeouts (common
      // on cloud providers like Render and Atlas) without extra overhead.
      heartbeatFrequencyMS: 30000,
    });
    console.log(`[Database] Connected to external MongoDB at ${redactMongoUri(env.MONGODB_URI)}`);
    return mongoose;
  } catch (err: any) {
    if (env.NODE_ENV === 'production') {
      console.error('[Database] Failed to connect to MongoDB in production mode:', err.message);
      throw err;
    }

    // In development or test, spin up an embedded in-memory MongoDB instance
    console.warn(`[Database] Could not connect to external MongoDB (${err.message}).`);
    console.log('[Database] Starting embedded MongoMemoryServer for development/testing...');
    
    try {
      const dynamicImport = new Function('specifier', 'return import(specifier)');
      const { MongoMemoryServer } = await dynamicImport('mongodb-memory-server');
      memoryServer = await MongoMemoryServer.create();
      const memUri = memoryServer.getUri();
      await mongoose.connect(memUri);
      console.log(`[Database] Connected to embedded in-memory MongoDB at ${memUri}`);
      return mongoose;
    } catch (memErr: any) {
      console.error('[Database] Failed to initialize embedded MongoMemoryServer:', memErr.message);
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
