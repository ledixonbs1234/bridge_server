/**
 * Error Handler Utilities
 * Centralized error handling with consistent response format
 */

import logger from './logger.js';

/**
 * Custom Application Error class
 */
export class AppError extends Error {
    constructor(message, statusCode = 500, code = 'INTERNAL_ERROR', details = null) {
        super(message);
        this.name = 'AppError';
        this.statusCode = statusCode;
        this.code = code;
        this.details = details;
        this.isOperational = true;
        
        Error.captureStackTrace(this, this.constructor);
    }
}

/**
 * Validation Error for input validation failures
 */
export class ValidationError extends AppError {
    constructor(message, details = null) {
        super(message, 400, 'VALIDATION_ERROR', details);
        this.name = 'ValidationError';
    }
}

/**
 * Not Found Error for missing resources
 */
export class NotFoundError extends AppError {
    constructor(resource = 'Resource') {
        super(`${resource} not found`, 404, 'NOT_FOUND');
        this.name = 'NotFoundError';
    }
}

/**
 * Unauthorized Error for authentication failures
 */
export class UnauthorizedError extends AppError {
    constructor(message = 'Unauthorized') {
        super(message, 401, 'UNAUTHORIZED');
        this.name = 'UnauthorizedError';
    }
}

/**
 * Forbidden Error for authorization failures
 */
export class ForbiddenError extends AppError {
    constructor(message = 'Forbidden') {
        super(message, 403, 'FORBIDDEN');
        this.name = 'ForbiddenError';
    }
}

/**
 * Conflict Error for resource conflicts
 */
export class ConflictError extends AppError {
    constructor(message = 'Conflict') {
        super(message, 409, 'CONFLICT');
        this.name = 'ConflictError';
    }
}

/**
 * Service Unavailable Error
 */
export class ServiceUnavailableError extends AppError {
    constructor(message = 'Service temporarily unavailable') {
        super(message, 503, 'SERVICE_UNAVAILABLE');
        this.name = 'ServiceUnavailableError';
    }
}

/**
 * Format error response
 */
export function formatErrorResponse(err, includeStack = false) {
    const response = {
        success: false,
        error: {
            message: err.message || 'An unexpected error occurred',
            code: err.code || 'INTERNAL_ERROR'
        }
    };

    if (err.details) {
        response.error.details = err.details;
    }

    if (includeStack && err.stack) {
        response.error.stack = err.stack;
    }

    return response;
}

/**
 * Express error handler middleware
 */
export function errorHandler() {
    return (err, req, res, next) => {
        // Log the error
        if (err.isOperational) {
            logger.warn('Operational error', {
                error: err.message,
                code: err.code,
                path: req.path,
                method: req.method
            });
        } else {
            logger.error('Unexpected error', {
                error: err.message,
                stack: err.stack,
                path: req.path,
                method: req.method
            });
        }

        // Determine status code
        const statusCode = err.statusCode || 500;

        // Don't leak stack traces in production for non-operational errors
        const isDev = process.env.NODE_ENV === 'development';
        const includeStack = isDev && !err.isOperational;

        // Send response
        res.status(statusCode).json(formatErrorResponse(err, includeStack));
    };
}

/**
 * Async handler wrapper to catch promise rejections
 */
export function asyncHandler(fn) {
    return (req, res, next) => {
        Promise.resolve(fn(req, res, next)).catch(next);
    };
}

/**
 * Handle promise rejection with custom error
 */
export async function handlePromise(promise, errorMessage = 'Operation failed') {
    try {
        const result = await promise;
        return [null, result];
    } catch (err) {
        return [err, null];
    }
}

/**
 * Retry utility with exponential backoff
 */
export async function retry(fn, options = {}) {
    const {
        maxRetries = 3,
        baseDelay = 1000,
        maxDelay = 10000,
        factor = 2,
        onRetry = null
    } = options;

    let lastError;
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            return await fn();
        } catch (err) {
            lastError = err;
            
            if (attempt < maxRetries) {
                const delay = Math.min(baseDelay * Math.pow(factor, attempt - 1), maxDelay);
                
                if (onRetry) {
                    onRetry({ attempt, error: err, delay });
                }
                
                logger.debug('Retry attempt', { 
                    attempt, 
                    maxRetries, 
                    delay,
                    error: err.message 
                });
                
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
    }
    
    throw lastError;
}

/**
 * Timeout wrapper for promises
 */
export function withTimeout(promise, ms, errorMessage = 'Operation timed out') {
    const timeout = new Promise((_, reject) => {
        setTimeout(() => reject(new AppError(errorMessage, 504, 'TIMEOUT')), ms);
    });
    
    return Promise.race([promise, timeout]);
}

/**
 * Safe JSON parse that doesn't throw
 */
export function safeJsonParse(str, defaultValue = null) {
    try {
        return JSON.parse(str);
    } catch {
        return defaultValue;
    }
}

/**
 * Create a safe async function that returns [error, result] tuple
 */
export function safeAsync(fn) {
    return async (...args) => {
        try {
            const result = await fn(...args);
            return [null, result];
        } catch (err) {
            return [err, null];
        }
    };
}
