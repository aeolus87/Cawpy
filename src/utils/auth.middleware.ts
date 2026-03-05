import { Request, Response, NextFunction } from 'express';
import * as jwt from 'jsonwebtoken';
import { ENV } from '../config/env';

const ETH_ADDRESS_REGEX = /^0x[a-fA-F0-9]{40}$/;

const pickString = (...values: unknown[]): string | undefined => {
    for (const value of values) {
        if (typeof value === 'string' && value.trim().length > 0) {
            return value.trim();
        }
    }
    return undefined;
};

const normalizeAddress = (value: unknown): string | undefined => {
    if (typeof value !== 'string') return undefined;
    const candidate = value.trim();
    if (!ETH_ADDRESS_REGEX.test(candidate)) return undefined;
    return candidate.toLowerCase();
};

const resolveAddress = (decoded: any): string | undefined => {
    return normalizeAddress(
        pickString(
            decoded?.address,
            decoded?.walletAddress,
            decoded?.userAddress,
            decoded?.wallet,
            decoded?.proxyWallet,
            decoded?.subAddress
        )
    );
};

const resolveMoniqoId = (decoded: any): string | undefined => {
    return pickString(decoded?.moniqoId, decoded?.userId, decoded?.sub, decoded?.uid);
};

const resolveRole = (decoded: any): 'admin' | 'user' => {
    return decoded?.role === 'admin' ? 'admin' : 'user';
};

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

    try {
        const decoded = jwt.verify(token, ENV.JWT_SECRET) as any;

        // Normalize user object for Polycopy format
        req.user = {
            address: resolveAddress(decoded),
            moniqoId: resolveMoniqoId(decoded),
            email: decoded.email,
            role: resolveRole(decoded),
            permissions: decoded.permissions || []
        };
        next();
    } catch (error) {
        return res.status(403).json({
            success: false,
            error: 'Invalid or expired token',
            timestamp: Date.now()
        });
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
