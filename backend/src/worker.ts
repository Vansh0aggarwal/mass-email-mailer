import { connectDatabase, disconnectDatabase } from './config/database.js';
import { env } from './config/env.js';
import { campaignSchedulerService } from './services/campaign-scheduler.service.js';

async function runWorker() {
  try {
    console.log('[Swaniki Radar Worker] Booting background scheduler worker...');
    await connectDatabase();

    campaignSchedulerService.start();
    console.log(`[Swaniki Radar Worker] Background campaign scheduler running (Environment: ${env.NODE_ENV})`);

    const shutdown = async (signal: string) => {
      console.log(`\n[Swaniki Radar Worker] Received ${signal}. Gracefully stopping scheduler...`);
      campaignSchedulerService.stop();
      await disconnectDatabase();
      process.exit(0);
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  } catch (err: any) {
    console.error('[Swaniki Radar Worker] Startup failed:', err.message);
    process.exit(1);
  }
}

runWorker();
