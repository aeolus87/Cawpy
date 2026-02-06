import { Request, Response, NextFunction } from 'express';
import * as jwt from 'jsonwebtoken';
import { ENV } from '../config/env';

export interface AuthRequest extends Request {
    user?: {
        address?: string;      // Ethereum address (Polycopy native)
        moniqoId?: string;     // Moniqo user ID
        email?: string;        // User email from Moniqo
        role: 'admin' | 'user';
        permissions?: string[]; // Additional permissions
    };
}

export function authenticateToken(req: AuthRequest, res: Response, next: NextFunction) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

    if (!token) {
        return res.status(401).json({
            success: false,
            error: 'Access token required',
            timestamp: Date.now()
        });
    }

    // Try to verify token with Polycopy's JWT secret
    try {
        const decoded = jwt.verify(token, ENV.JWT_SECRET) as any;

        // Normalize user object for Polycopy format
        req.user = {
            address: decoded.address,
            moniqoId: decoded.moniqoId || decoded.userId,
            email: decoded.email,
            role: decoded.role || 'user',
            permissions: decoded.permissions || []
        };
        next();
    } catch (polycopyError) {
        // If Polycopy verification fails, try Moniqo token validation
        try {
            // For Moniqo integration, accept tokens signed with different secrets
            // or with different structures. You may need to adjust this based on Moniqo's token format
            const decoded = jwt.decode(token) as any;

            // Accept Moniqo tokens if they have required fields
            if (decoded && (decoded.moniqoId || decoded.userId || decoded.sub)) {
                req.user = {
                    moniqoId: decoded.moniqoId || decoded.userId || decoded.sub,
                    email: decoded.email,
                    address: decoded.address, // May be provided by Moniqo
                    role: decoded.role || 'user',
                    permissions: decoded.permissions || []
                };
                next();
            } else {
                throw new Error('Invalid token structure');
            }
        } catch (moniqoError) {
            return res.status(403).json({
                success: false,
                error: 'Invalid or expired token',
                timestamp: Date.now()
            });
        }
    }
}

export function requireAdmin(req: AuthRequest, res: Response, next: NextFunction) {
    if (req.user?.role !== 'admin') {
        return res.status(403).json({
            success: false,
            error: 'Admin access required',
            timestamp: Date.now()
        });
    }
    next();
}