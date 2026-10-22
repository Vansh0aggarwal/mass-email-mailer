import { Request, Response, NextFunction } from 'express';
import { env } from '../config/env.js';

export type UserRole = 'owner' | 'admin' | 'manager' | 'sales_rep' | 'viewer';

declare global {
  namespace Express {
    interface Request {
      organizationId: string;
      userId: string;
      userRole: UserRole;
      isDevMock: boolean;
      sessionExpired?: boolean;
      sessionId?: string;
      hasValidSession?: boolean;
    }
  }
}

import { sessionMiddleware } from './session.js';

export const tenantContextMiddleware = sessionMiddleware;
