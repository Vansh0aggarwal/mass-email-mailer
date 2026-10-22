import { Router, Request, Response } from 'express';
import mongoose from 'mongoose';
import { env } from '../config/env.js';

const router = Router();

router.get('/', (_req: Request, res: Response) => {
  const dbState = mongoose.connection.readyState;
  const dbStatusMap: Record<number, string> = {
    0: 'disconnected',
    1: 'connected',
    2: 'connecting',
    3: 'disconnecting',
  };

  const status = dbState === 1 ? 'ok' : 'degraded';

  res.status(200).json({
    success: true,
    data: {
      status,
      timestamp: new Date().toISOString(),
      service: 'swaniki-radar-api',
      version: '1.0.0',
      nodeEnv: env.NODE_ENV,
      database: {
        status: dbStatusMap[dbState] || 'unknown',
        host: mongoose.connection.host || 'in-memory',
        name: mongoose.connection.name || 'swaniki_radar',
      },
      providers: {
        ai: env.AI_PROVIDER,
        email: env.EMAIL_PROVIDER,
      },
      uptimeSeconds: Math.floor(process.uptime()),
      memory: {
        rssMb: Math.round(process.memoryUsage().rss / (1024 * 1024)),
        heapUsedMb: Math.round(process.memoryUsage().heapUsed / (1024 * 1024)),
      },
    },
  });
});

export default router;
