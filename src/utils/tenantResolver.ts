import { AuthRequest } from './auth.middleware';

export const resolveTenantId = (user: AuthRequest['user']): string | null => {
    const moniqoId = typeof user?.moniqoId === 'string' ? user.moniqoId.trim() : '';
    if (moniqoId) {
        return moniqoId;
    }

    const address = typeof user?.address === 'string' ? user.address.trim().toLowerCase() : '';
    if (address) {
        return `wallet:${address}`;
    }

    return null;
};
