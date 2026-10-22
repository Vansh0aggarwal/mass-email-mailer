import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { env } from '../config/env.js';

export class AppError extends Error {
  public statusCode: number;
  public code: string;
  public details?: any;

  constructor(message: string, statusCode: number = 400, code: string = 'BAD_REQUEST', details?: any) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function errorHandler(
  err: any,
  _req: Request,
  res: Response,
  _next: NextFunction
): void {
  // Handle custom AppError first so deliberate 413s keep their specific code
  // (e.g. FILE_TOO_LARGE / TOO_MANY_ROWS) and message.
  if (err instanceof AppError) {
    res.status(err.statusCode).json({
      success: false,
      error: {
        code: err.code,
        message: err.message,
        details: err.details,
      },
    });
    return;
  }

  // Handle body-parser payload too large (multipart/JSON upload rejected before routing)
  // and our own deliberate 413s (FILE_TOO_LARGE / TOO_MANY_ROWS), preserving the
  // specific code + message when we set one.
  if (err && (err.type === 'entity.too.large' || err.status === 413 || err.statusCode === 413)) {
    const knownCodes = ['FILE_TOO_LARGE', 'TOO_MANY_ROWS'];
    const code = knownCodes.includes(err.code) ? err.code : 'PAYLOAD_TOO_LARGE';
    res.status(413).json({
      success: false,
      error: {
        code,
        message:
          code === 'PAYLOAD_TOO_LARGE'
            ? 'The uploaded file is too large for the server to accept. Reduce the file size or contact support to raise the upload limit.'
            : err.message,
      },
    });
    return;
  }

  // Handle Zod validation errors
  if (err instanceof ZodError) {
    res.status(400).json({
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Invalid request data',
        issues: err.issues.map((i) => ({
          path: i.path.join('.'),
          message: i.message,
        })),
      },
    });
    return;
  }

  // Handle Mongoose duplicate key error (11000)
  if (err && err.code === 11000) {
    const keys = Object.keys(err.keyPattern || err.keyValue || {});
    res.status(409).json({
      success: false,
      error: {
        code: 'DUPLICATE_RESOURCE',
        message: `A record with matching ${keys.join(', ')} already exists`,
        details: err.keyValue,
      },
    });
    return;
  }

  // Handle Mongoose CastError (e.g. invalid ObjectId)
  if (err && err.name === 'CastError') {
    res.status(400).json({
      success: false,
      error: {
        code: 'INVALID_ID',
        message: `Resource identifier '${err.value}' is invalid`,
      },
    });
    return;
  }

  // Generic 500 error
  console.error('[Unhandled Error]', err);
  const status = typeof err.statusCode === 'number' ? err.statusCode : 500;
  res.status(status).json({
    success: false,
    error: {
      code: 'INTERNAL_SERVER_ERROR',
      message: env.NODE_ENV === 'production' ? 'An unexpected server error occurred' : err.message,
    },
  });
}
