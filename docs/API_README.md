# PolyCopy API Server

The PolyCopy API server provides REST and WebSocket endpoints for frontend applications to interact with the copy trading bot.

## Quick Start

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure Environment

Copy `.env.example` to `.env` and configure the API settings:

```bash
cp .env.example .env
```

Required API settings:

```env
# Enable API server
ENABLE_API=true

# API server configuration
API_PORT=3001
API_HOST=localhost
JWT_SECRET=your-super-secret-jwt-key-change-in-production

# CORS for frontend
CORS_ORIGIN=http://localhost:3000

# Rate limiting
API_RATE_LIMIT_WINDOW_MS=900000  # 15 minutes
API_RATE_LIMIT_MAX_REQUESTS=100  # 100 requests per window
```

### 3. Start the API Server

```bash
# Development mode (with hot reload)
npm run api:dev

# Production mode
npm run api
```

The API will be available at `http://localhost:3001`

## Authentication

### JWT Authentication

The API uses JWT tokens for authentication. To get a token:

```bash
curl -X POST http://localhost:3001/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{
    "address": "0x1234567890123456789012345678901234567890",
    "signature": "signature_here"
  }'
```

Use the returned token in subsequent requests:

```bash
curl -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  http://localhost:3001/api/positions
```

## API Endpoints

### Health Check

```bash
GET /health
```

Returns server health status.

### Authentication

```bash
POST /api/auth/login
```

Authenticate and receive JWT token.

### Trading Control

```bash
GET    /api/trading/status   # Get bot status
POST   /api/trading/start    # Start bot (admin only)
POST   /api/trading/stop     # Stop bot (admin only)
```

### Position Management

```bash
GET    /api/positions        # Get current positions
POST   /api/positions/close  # Close positions (admin only)
```

### Analytics

```bash
GET /api/analytics/performance  # Get performance metrics
GET /api/analytics/trades       # Get trade history (paginated)
```

### Reconciliation

```bash
POST /api/reconciliation/run  # Run position reconciliation (admin only)
```

## WebSocket API

Connect to real-time updates:

```javascript
const ws = new WebSocket('ws://localhost:3001/ws?token=YOUR_JWT_TOKEN');

// Listen for events
ws.onmessage = (event) => {
  const data = JSON.parse(event.data);

  switch(data.type) {
    case 'trade_executed':
      console.log('Trade executed:', data.payload);
      break;
    case 'position_updated':
      console.log('Position updated:', data.payload);
      break;
  }
};
```

## Rate Limiting

- **General API**: 100 requests per 15 minutes
- **Trading endpoints**: 10 requests per minute
- **Analytics**: 30 requests per minute
- **Admin endpoints**: 5 requests per minute

## API Documentation

When `ENABLE_API_DOCS=true`, Swagger UI is available at:

```
http://localhost:3001/api-docs
```

## Frontend Integration Example

```javascript
// React hook for API integration
import { useState, useEffect } from 'react';

export function usePolyCopyAPI(token: string) {
  const [positions, setPositions] = useState([]);
  const [isConnected, setIsConnected] = useState(false);

  useEffect(() => {
    if (!token) return;

    // Fetch initial positions
    fetch('/api/positions', {
      headers: { Authorization: `Bearer ${token}` }
    })
    .then(res => res.json())
    .then(data => setPositions(data.data));

    // WebSocket connection
    const ws = new WebSocket(`ws://localhost:3001/ws?token=${token}`);

    ws.onopen = () => setIsConnected(true);
    ws.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.type === 'position_updated') {
        // Update positions in real-time
        setPositions(prev => /* update logic */);
      }
    };

    return () => ws.close();
  }, [token]);

  return { positions, isConnected };
}
```

## Security Considerations

### Production Deployment

1. **HTTPS Only**: Always use HTTPS in production
2. **Strong JWT Secret**: Use a cryptographically secure random string
3. **Rate Limiting**: Configure appropriate limits for your use case
4. **CORS Policy**: Restrict to your frontend domain only
5. **API Documentation**: Disable in production (`ENABLE_API_DOCS=false`)

### Wallet Authentication

For production, implement proper wallet signature verification:

```typescript
import { ethers } from 'ethers';

async function verifySignature(address: string, signature: string, message: string) {
  const recoveredAddress = ethers.utils.verifyMessage(message, signature);
  return recoveredAddress.toLowerCase() === address.toLowerCase();
}
```

## Troubleshooting

### Common Issues

1. **CORS Errors**: Check `CORS_ORIGIN` matches your frontend URL
2. **Authentication Failed**: Verify JWT token format and expiration
3. **Rate Limited**: Wait for rate limit window to reset
4. **WebSocket Connection Failed**: Check token and server URL

### Logs

API server logs are available in the console. Enable debug logging:

```bash
DEBUG=* npm run api:dev
```

## Support

For API integration questions, refer to:
- [PRD - Product Requirements Document](./PRD_Product_Requirements_Document.md)
- [SDD - Software Design Document](./SDD_Software_Design_Document.md)
- [Full API Documentation](http://localhost:3001/api-docs) (when enabled)