import { sessionMiddleware } from './session.js';

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

export const tenantContextMiddleware = sessionMiddleware;
