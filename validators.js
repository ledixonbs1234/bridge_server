/**
 * Request Validation Middleware
 * Provides input validation and sanitization for API endpoints
 */

import logger from './logger.js';

/**
 * Validate required fields in request body
 */
export function validateRequiredFields(fields) {
    return (req, res, next) => {
        const missing = [];
        
        for (const field of fields) {
            if (!req.body[field] && req.body[field] !== false && req.body[field] !== 0) {
                missing.push(field);
            }
        }
        
        if (missing.length > 0) {
            logger.warn('Missing required fields', { 
                endpoint: req.path, 
                missing 
            });
            return res.status(400).json({
                success: false,
                error: 'Missing required fields',
                missing
            });
        }
        
        next();
    };
}

/**
 * Validate string field with length limits
 */
export function validateStringField(fieldName, options = {}) {
    const { minLength = 1, maxLength = 10000, required = false, pattern = null } = options;
    
    return (req, res, next) => {
        const value = req.body[fieldName];
        
        if (!value) {
            if (required) {
                return res.status(400).json({
                    success: false,
                    error: `Field '${fieldName}' is required`
                });
            }
            return next();
        }
        
        if (typeof value !== 'string') {
            return res.status(400).json({
                success: false,
                error: `Field '${fieldName}' must be a string`
            });
        }
        
        if (value.length < minLength) {
            return res.status(400).json({
                success: false,
                error: `Field '${fieldName}' must be at least ${minLength} characters`
            });
        }
        
        if (value.length > maxLength) {
            return res.status(400).json({
                success: false,
                error: `Field '${fieldName}' must not exceed ${maxLength} characters`
            });
        }
        
        if (pattern && !pattern.test(value)) {
            return res.status(400).json({
                success: false,
                error: `Field '${fieldName}' has invalid format`
            });
        }
        
        next();
    };
}

/**
 * Validate numeric field with range
 */
export function validateNumberField(fieldName, options = {}) {
    const { min = -Infinity, max = Infinity, required = false, integer = false } = options;
    
    return (req, res, next) => {
        const value = req.body[fieldName];
        
        if (value === undefined || value === null) {
            if (required) {
                return res.status(400).json({
                    success: false,
                    error: `Field '${fieldName}' is required`
                });
            }
            return next();
        }
        
        const num = Number(value);
        
        if (isNaN(num)) {
            return res.status(400).json({
                success: false,
                error: `Field '${fieldName}' must be a number`
            });
        }
        
        if (integer && !Number.isInteger(num)) {
            return res.status(400).json({
                success: false,
                error: `Field '${fieldName}' must be an integer`
            });
        }
        
        if (num < min || num > max) {
            return res.status(400).json({
                success: false,
                error: `Field '${fieldName}' must be between ${min} and ${max}`
            });
        }
        
        next();
    };
}

/**
 * Validate array field
 */
export function validateArrayField(fieldName, options = {}) {
    const { minLength = 0, maxLength = 1000, required = false, itemType = null } = options;
    
    return (req, res, next) => {
        const value = req.body[fieldName];
        
        if (!value) {
            if (required) {
                return res.status(400).json({
                    success: false,
                    error: `Field '${fieldName}' is required`
                });
            }
            return next();
        }
        
        if (!Array.isArray(value)) {
            return res.status(400).json({
                success: false,
                error: `Field '${fieldName}' must be an array`
            });
        }
        
        if (value.length < minLength || value.length > maxLength) {
            return res.status(400).json({
                success: false,
                error: `Field '${fieldName}' must have between ${minLength} and ${maxLength} items`
            });
        }
        
        if (itemType) {
            const invalidIndex = value.findIndex(item => typeof item !== itemType);
            if (invalidIndex !== -1) {
                return res.status(400).json({
                    success: false,
                    error: `Item at index ${invalidIndex} in '${fieldName}' must be of type ${itemType}`
                });
            }
        }
        
        next();
    };
}

/**
 * Sanitize string to prevent XSS and injection attacks
 */
export function sanitizeString(str) {
    if (typeof str !== 'string') {
        return str;
    }
    
    // Remove null bytes
    str = str.replace(/\0/g, '');
    
    // Limit length
    if (str.length > 10000) {
        str = str.substring(0, 10000);
    }
    
    return str;
}

/**
 * Sanitize request body
 */
export function sanitizeBody(fields) {
    return (req, res, next) => {
        for (const field of fields) {
            if (req.body[field] && typeof req.body[field] === 'string') {
                req.body[field] = sanitizeString(req.body[field]);
            }
        }
        next();
    };
}

/**
 * Validate file path to prevent path traversal attacks
 */
export function validateFilePath(fieldName, baseDir) {
    return (req, res, next) => {
        const filePath = req.body[fieldName] || req.params[fieldName];
        
        if (!filePath) {
            return next();
        }
        
        // Check for path traversal attempts
        if (filePath.includes('..') || filePath.startsWith('/') || filePath.includes('\\')) {
            logger.warn('Path traversal attempt detected', { 
                endpoint: req.path,
                path: filePath 
            });
            return res.status(400).json({
                success: false,
                error: 'Invalid file path'
            });
        }
        
        // Ensure filename only contains safe characters
        const safePattern = /^[a-zA-Z0-9_\-.\s]+$/;
        if (!safePattern.test(filePath)) {
            logger.warn('Unsafe filename detected', { 
                endpoint: req.path,
                filename: filePath 
            });
            return res.status(400).json({
                success: false,
                error: 'Filename contains invalid characters'
            });
        }
        
        next();
    };
}

/**
 * Rate limiting helper (simple in-memory implementation)
 */
class SimpleRateLimiter {
    constructor(options = {}) {
        this.windowMs = options.windowMs || 60000; // 1 minute
        this.maxRequests = options.maxRequests || 100;
        this.requests = new Map();
        
        // Cleanup old entries every minute
        setInterval(() => {
            const now = Date.now();
            for (const [key, data] of this.requests.entries()) {
                if (now - data.startTime > this.windowMs) {
                    this.requests.delete(key);
                }
            }
        }, 60000);
    }
    
    middleware() {
        return (req, res, next) => {
            const ip = req.ip || req.connection.remoteAddress || 'unknown';
            const now = Date.now();
            
            let requestData = this.requests.get(ip);
            
            if (!requestData || now - requestData.startTime > this.windowMs) {
                requestData = { count: 0, startTime: now };
                this.requests.set(ip, requestData);
            }
            
            requestData.count++;
            
            if (requestData.count > this.maxRequests) {
                logger.warn('Rate limit exceeded', { ip, count: requestData.count });
                return res.status(429).json({
                    success: false,
                    error: 'Too many requests, please try again later'
                });
            }
            
            next();
        };
    }
}

export { SimpleRateLimiter };
