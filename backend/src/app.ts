import express, { Express, Request, Response, NextFunction } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import morgan from 'morgan';
import { env } from './config/env.js';
import { tenantContextMiddleware } from './middleware/tenantContext.js';
import { errorHandler } from './middleware/errorHandler.js';
import { globalRateLimiter } from './middleware/rateLimiter.js';
import cookieParser from 'cookie-parser';
import healthRouter from './routes/health.js';
import authRouter from './routes/auth.js';
import gmailIntegrationRouter from './routes/gmail-integration.js';
import companiesRouter from './routes/companies.js';
import contactsRouter from './routes/contacts.js';
import importsRouter from './routes/imports.js';
import servicesRouter from './routes/services.js';
import opportunitiesRouter from './routes/opportunities.js';
import templatesRouter from './routes/templates.js';
import draftsRouter from './routes/drafts.js';
import mailboxesRouter from './routes/mailboxes.js';
import followupsRouter from './routes/followups.js';
import campaignsRouter from './routes/campaigns.js';
import analyticsRouter from './routes/analytics.js';
import settingsRouter from './routes/settings.js';
import calendarRouter from './routes/calendar.js';
import deliverabilityRouter from './routes/deliverability.js';
import teamRouter from './routes/team.js';
import searchRouter from './routes/search.js';

export function createApp(): Express {
  const app = express();

  // Trust reverse proxy headers (X-Forwarded-Proto, X-Forwarded-For) in cloud/production environments
  // This ensures HTTPS detection, secure cookies, and accurate rate limiting behind Vercel/Render/NGINX/Cloudflare.
  app.set('trust proxy', 1);

  // Security Headers
  app.use(helmet());

  // CORS Configuration
  const allowedOrigins = [env.CLIENT_URL, 'http://localhost:5173', 'http://localhost:3000'];
  app.use(
    cors({
      origin: (origin, callback) => {
        if (!origin || allowedOrigins.includes(origin) || env.NODE_ENV !== 'production') {
          callback(null, true);
        } else {
          callback(new Error('Blocked by CORS policy'));
        }
      },
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'x-organization-id', 'x-user-id', 'x-user-role', 'idempotency-key'],
    })
  );

  // Request Body Parsers
  // CSV prospect files can be several megabytes; the body limit is configurable
  // (IMPORT_MAX_FILE_BYTES controls the semantic limit enforced per route).
  app.use(express.json({ limit: env.JSON_BODY_LIMIT }));
  app.use(express.urlencoded({ extended: true, limit: env.JSON_BODY_LIMIT }));
  app.use(express.text({ type: ['text/csv', 'text/plain'], limit: env.JSON_BODY_LIMIT }));

  // Logging
  if (env.NODE_ENV !== 'test') {
    app.use(morgan(':method :url :status :res[content-length] - :response-time ms'));
  }

  // Rate Limiting
  app.use('/api', globalRateLimiter);

  // Cookies parser
  app.use(cookieParser());

  // Tenant Isolation & Identity Context
  app.use(tenantContextMiddleware);

  // API v1 Routes
  const apiV1Router = express.Router();
  apiV1Router.use('/health', healthRouter);
  apiV1Router.use('/auth', authRouter);
  apiV1Router.use('/integrations/google/gmail', gmailIntegrationRouter);
  apiV1Router.use('/companies', companiesRouter);
  apiV1Router.use('/contacts', contactsRouter);
  apiV1Router.use('/imports', importsRouter);
  apiV1Router.use('/services', servicesRouter);
  apiV1Router.use('/opportunities', opportunitiesRouter);
  apiV1Router.use('/templates', templatesRouter);
  apiV1Router.use('/drafts', draftsRouter);
  apiV1Router.use('/mailboxes', mailboxesRouter);
  apiV1Router.use('/follow-ups', followupsRouter);
  apiV1Router.use('/campaigns', campaignsRouter);
  apiV1Router.use('/analytics', analyticsRouter);
  apiV1Router.use('/settings', settingsRouter);
  apiV1Router.use('/calendar', calendarRouter);
  apiV1Router.use('/integrations/google/calendar', calendarRouter);
  apiV1Router.use('/deliverability', deliverabilityRouter);
  apiV1Router.use('/team', teamRouter);
  apiV1Router.use('/search', searchRouter);

  app.use('/api/v1', apiV1Router);

  // 404 Route Handler
  app.use((req: Request, res: Response) => {
    res.status(404).json({
      success: false,
      error: {
        code: 'NOT_FOUND',
        message: `Route '${req.method} ${req.path}' not found on Swaniki Radar API`,
      },
    });
  });

  // Centralized Error Handler
  app.use(errorHandler);

  return app;
}
