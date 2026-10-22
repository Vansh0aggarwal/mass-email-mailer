import { createApp } from './app.js';
import { connectDatabase, disconnectDatabase } from './config/database.js';
import { env } from './config/env.js';
import { campaignSchedulerService } from './services/campaign-scheduler.service.js';
import { mailboxSyncWorkerService } from './services/mailbox-sync-worker.service.js';
import { cleanupExpiredImports, ensureUploadDir } from './services/import-job.service.js';
import { campaignService } from './services/campaign.service.js';

async function bootstrap() {
  try {
    await connectDatabase();
    const app = createApp();

    // Durable, restart-safe scheduled campaign processing (no frontend timers).
    campaignSchedulerService.start();

    // Background synchronization worker for connected Gmail mailboxes.
    mailboxSyncWorkerService.start();

    // Ensure the CSV upload directory exists and sweep expired temp files.
    try {
      ensureUploadDir();
      await cleanupExpiredImports();
      const recovered = await campaignService.recoverDanglingJobs();
      if (recovered > 0) {
        console.log(`[Swaniki Radar Server] Recovered ${recovered} interrupted campaign import job(s)`);
      }
    } catch (err: any) {
      console.warn('[Swaniki Radar Server] CSV import cleanup skipped:', err?.message);
    }

    const server = app.listen(env.PORT, () => {
      console.log(`[Swaniki Radar Server] Running at http://localhost:${env.PORT}`);
      console.log(`[Swaniki Radar Server] API Root: http://localhost:${env.PORT}/api/v1`);
      console.log(`[Swaniki Radar Server] Environment: ${env.NODE_ENV}`);
    });

    const shutdown = async (signal: string) => {
      console.log(`\n[Swaniki Radar Server] Received ${signal}. Gracefully shutting down...`);
      campaignSchedulerService.stop();
      mailboxSyncWorkerService.stop();
      server.close(async () => {
        await disconnectDatabase();
        process.exit(0);
      });
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  } catch (err: any) {
    console.error('[Swaniki Radar Server] Startup failed:', err.message);
    process.exit(1);
  }
}

bootstrap();
