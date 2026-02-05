# PolyCopy - Software Design Document (SDD)

## Document Information

| Field | Value |
|-------|-------|
| **Document Title** | PolyCopy Software Design Document |
| **Version** | 1.0.0 |
| **Date** | 2026-02-05 |
| **Author** | PolyCopy Development Team |
| **Status** | Final |

---

## Table of Contents

1. [Introduction](#1-introduction)
2. [System Architecture](#2-system-architecture)
3. [Data Architecture](#3-data-architecture)
4. [API Design](#4-api-design)
5. [Security Architecture](#5-security-architecture)
6. [Performance Design](#6-performance-design)
7. [Error Handling & Resilience](#7-error-handling--resilience)
8. [Testing Strategy](#8-testing-strategy)
9. [Deployment & Operations](#9-deployment--operations)
10. [Appendices](#10-appendices)

---

## 1. Introduction

### 1.1 Purpose

This Software Design Document (SDD) provides a comprehensive technical specification for the PolyCopy platform, detailing the system architecture, data models, API interfaces, security measures, and implementation guidelines.

### 1.2 Scope

The SDD covers:

- System architecture and component interactions
- Database schema and data flow
- REST API and WebSocket interfaces
- Security protocols and authentication
- Performance optimization strategies
- Error handling and recovery mechanisms
- Testing methodologies
- Deployment and operational procedures

### 1.3 Assumptions and Constraints

#### Technical Constraints
- Target platforms: Node.js 18+, MongoDB 6.0+
- Blockchain: Polygon mainnet with fallback to testnet
- External APIs: Polymarket v2 API, price feeds
- Performance: <100ms API response times, <5s trade execution

#### Business Constraints
- Zero-tolerance safety approach
- 99.9% uptime requirement
- GDPR compliance for user data
- SOC 2 compliance for financial operations

### 1.4 Definitions and Acronyms

| Term | Definition |
|------|------------|
| CLOB | Central Limit Order Book |
| JWT | JSON Web Token |
| MEV | Maximal Extractable Value |
| PRD | Product Requirements Document |
| SDD | Software Design Document |
| SLA | Service Level Agreement |

---

## 2. System Architecture

### 2.1 High-Level Architecture

```
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│   Frontend UI   │    │   PolyCopy API  │    │  External APIs  │
│   (React/Vue)   │◄──►│   (Express.js)  │◄──►│   (Polymarket)  │
└─────────────────┘    └─────────────────┘    └─────────────────┘
         │                       │                       │
         ▼                       ▼                       ▼
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│   WebSocket     │    │   Trade Engine  │    │   Blockchain    │
│   Real-time     │◄──►│   (Guarded)     │◄──►│   (Polygon)     │
└─────────────────┘    └─────────────────┘    └─────────────────┘
         ▲                       ▲                       ▲
         │                       │                       │
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│   Monitoring    │    │   Database      │    │   Cache/Queue   │
│   & Analytics   │◄──►│   (MongoDB)     │◄──►│   (Redis)       │
└─────────────────┘    └─────────────────┘    └─────────────────┘
```

### 2.2 Component Overview

#### Core Components

1. **API Server** (`src/server/api.ts`)
   - Express.js REST API with authentication
   - Swagger documentation
   - Rate limiting and security middleware

2. **Trade Engine** (`src/execution/guardedExecutor.ts`)
   - Single choke point for all order execution
   - Multi-layer safety guards
   - Idempotency and lease management

3. **Trade Monitor** (`src/services/tradeMonitor.ts`)
   - Real-time trade detection from Polymarket API
   - Timestamp validation and filtering
   - Trade aggregation and queuing

4. **Trade Executor** (`src/services/tradeExecutor.ts`)
   - Atomic trade claiming with lease management
   - Batch processing and error recovery
   - Performance monitoring

5. **Reconciliation Service** (`src/services/reconciliation.ts`)
   - Position validation against blockchain state
   - Discrepancy detection and reporting
   - Automatic reconciliation workflows

#### Supporting Components

6. **Database Layer** (`src/models/`)
   - MongoDB schema definitions
   - Data validation and relationships
   - Migration and backup utilities

7. **Security Layer** (`src/middleware/`)
   - Authentication and authorization
   - Input validation and sanitization
   - Audit logging

8. **Utility Layer** (`src/utils/`)
   - Market viability checks
   - Edge filter algorithms
   - Blockchain interaction helpers

### 2.3 Data Flow Architecture

#### Trade Detection Flow

```
Polymarket API ──► Trade Monitor ──► Database (detected)
       ↓
Trade Executor ──► Claim Lease ──► Trade Engine ──► Execute Order
       ↓
Reconciliation ──► Validate Position ──► Update Status
```

#### Safety Guard Flow

```
Trade Request ──► Timestamp Check ──► Idempotency Check
       ↓                    ↓                    ↓
   Viability ─────────► Edge Filters ─────► Position Check
       ↓                    ↓                    ↓
   Sizing ────────────► Slippage ─────────► Execute
       ↓                    ↓                    ↓
   Lease Release ─────► DB Update ────────► Success
```

### 2.4 Technology Stack

#### Backend Runtime
- **Node.js**: 18.17.0 LTS (Active LTS)
- **TypeScript**: 5.7.3 (strict mode enabled)
- **Express.js**: 4.21.0 (API server)

#### Database & Caching
- **MongoDB**: 6.0+ (document database)
- **Mongoose**: 8.9.5 (ODM with schema validation)
- **Redis**: 7.0+ (caching and queuing)

#### Blockchain Integration
- **@polymarket/clob-client**: 4.14.0 (official SDK)
- **ethers**: 5.8.0 (wallet and transaction management)
- **@polymarket/order-utils**: Signature utilities

#### Security & Monitoring
- **helmet**: Security headers
- **cors**: Cross-origin resource sharing
- **express-rate-limit**: API rate limiting
- **jsonwebtoken**: JWT authentication
- **winston**: Structured logging

#### Development Tools
- **Jest**: Testing framework (95%+ coverage target)
- **ESLint**: Code quality and consistency
- **Prettier**: Code formatting
- **TypeScript Compiler**: Type checking
- **Nodemon**: Development hot reload

---

## 3. Data Architecture

### 3.1 Database Schema

#### User Activity Collection
```javascript
{
  _id: ObjectId,              // MongoDB ObjectId
  proxyWallet: String,        // User's proxy wallet address
  timestamp: Number,          // Trade timestamp (seconds since epoch)
  conditionId: String,        // Polymarket condition ID
  type: String,               // Activity type (TRADE)
  size: Number,               // Trade size (positive for buy, negative for sell)
  usdcSize: Number,           // USD value of trade
  transactionHash: String,    // Blockchain transaction hash
  price: Number,              // Trade price
  asset: String,              // Token asset ID
  side: String,               // BUY or SELL
  outcomeIndex: Number,       // Market outcome index
  title: String,              // Market title
  slug: String,               // Market slug
  icon: String,               // Market icon URL
  eventSlug: String,          // Event slug
  outcome: String,            // Outcome description
  name: String,               // Trader name
  pseudonym: String,          // Trader pseudonym
  bio: String,                // Trader bio
  profileImage: String,       // Profile image URL
  profileImageOptimized: String, // Optimized profile image

  // Legacy compatibility fields
  bot: Boolean,               // Execution status (true = executed)
  botExcutedTime: Number,     // Legacy execution tracking

  // New lifecycle management
  lifecycleState: String,     // detected|claimed|executing|executed|skipped|failed|reconciled
  skipReason: String,         // Why trade was skipped
  failureReason: String,      // Why trade failed
  retryCount: Number,         // Number of retry attempts
  lastRetryAt: Number,        // Timestamp of last retry
  claimedAt: Number,          // When trade was claimed for processing
  executedAt: Number,         // When trade was successfully executed
  expectedTokens: Number,     // Expected token amount from order
  actualTokens: Number,       // Actual token amount received
  myBoughtSize: Number,       // Tracks tokens we actually bought

  // Safety and execution tracking
  idempotencyKey: String,     // Prevents duplicate execution
  clobOrderId: String,        // Order ID from Polymarket CLOB
  claimedBy: String,          // Worker ID that claimed this trade
  leaseExpiresAt: Number,     // Lease expiration timestamp

  // Fill tracking and risk management
  intendedSize: Number,       // USD amount we intended to fill
  filledSize: Number,         // USD amount actually filled
  avgFillPrice: Number,       // Average fill price
  needsManualReview: Boolean, // Flag for manual review of partial fills
}
```

#### User Position Collection
```javascript
{
  _id: ObjectId,
  proxyWallet: String,        // User's proxy wallet
  asset: String,              // Token asset ID
  conditionId: String,        // Polymarket condition ID
  size: Number,               // Current position size
  avgPrice: Number,           // Average purchase price
  initialValue: Number,       // Initial position value
  currentValue: Number,       // Current position value
  cashPnl: Number,            // Cash profit/loss
  percentPnl: Number,         // Percentage profit/loss
  totalBought: Number,        // Total tokens bought
  realizedPnl: Number,        // Realized profit/loss
  percentRealizedPnl: Number, // Realized percentage profit/loss
  curPrice: Number,           // Current market price
  redeemable: Boolean,        // Market is redeemable
  mergeable: Boolean,         // Position can be merged
  title: String,              // Market title
  slug: String,               // Market slug
  icon: String,               // Market icon URL
  eventSlug: String,          // Event slug
  outcome: String,            // Outcome description
  outcomeIndex: Number,       // Outcome index
  oppositeOutcome: String,    // Opposite outcome
  oppositeAsset: String,      // Opposite asset
  endDate: String,            // Market end date
  negativeRisk: Boolean,      // Negative risk position
}
```

#### Reconciliation Result Collection
```javascript
{
  _id: ObjectId,
  timestamp: Number,          // Reconciliation timestamp
  discrepancies: [{
    asset: String,
    conditionId: String,
    slug: String,
    expectedSize: Number,
    actualSize: Number,
    difference: Number,
    differencePercent: Number,
    severity: String          // 'info' | 'warning' | 'critical'
  }],
  summary: {
    totalPositions: Number,
    matchingPositions: Number,
    discrepancyCount: Number,
    criticalCount: Number
  }
}
```

### 3.2 Data Flow Patterns

#### Trade Processing Pipeline

1. **Ingestion**: Trade data from Polymarket API → `tradeMonitor.ts`
2. **Validation**: Timestamp and format validation
3. **Storage**: Raw trade data → MongoDB `user_activities_{address}`
4. **Claiming**: Atomic lease acquisition → `tradeExecutor.ts`
5. **Processing**: Safety guards + execution → `guardedExecutor.ts`
6. **Reconciliation**: Position validation → `reconciliation.ts`

#### Position Synchronization

1. **Fetch**: Current positions from Polymarket API
2. **Compare**: Expected vs actual positions
3. **Update**: Position collection with latest data
4. **Reconcile**: Detect and report discrepancies

### 3.3 Data Retention Policies

- **Trade History**: 2 years rolling retention
- **Position History**: 1 year rolling retention
- **Reconciliation Logs**: 6 months retention
- **Audit Logs**: 7 years retention (compliance requirement)
- **Performance Metrics**: 1 year aggregation, 30 days detailed

---

## 4. API Design

### 4.1 REST API Endpoints

#### Authentication Endpoints

```
POST /api/auth/login
- Authenticate user and return JWT token
- Body: { address: string, signature: string }
- Response: { success: boolean, data: { token: string, user: object } }
```

#### Trading Control Endpoints

```
GET /api/trading/status
- Get current trading bot status
- Response: { success: boolean, data: { isRunning: boolean, uptime: number } }

POST /api/trading/start
- Start the trading bot (admin only)
- Response: { success: boolean, data: { status: 'started' } }

POST /api/trading/stop
- Stop the trading bot (admin only)
- Response: { success: boolean, data: { status: 'stopped' } }
```

#### Position Management Endpoints

```
GET /api/positions
- Get current positions for authenticated user
- Response: { success: boolean, data: Position[] }

POST /api/positions/close
- Close specific positions (admin only)
- Body: { assetIds: string[] }
- Response: { success: boolean, data: { message: string, assetIds: string[] } }
```

#### Analytics Endpoints

```
GET /api/analytics/performance
- Get performance analytics
- Response: { success: boolean, data: PerformanceMetrics }

GET /api/analytics/trades
- Get trade history with pagination
- Query: limit=50, offset=0
- Response: { success: boolean, data: { trades: Trade[], count: number, offset: number, limit: number } }
```

#### Reconciliation Endpoints

```
POST /api/reconciliation/run
- Run position reconciliation (admin only)
- Response: { success: boolean, data: ReconciliationResult }
```

### 4.2 WebSocket API

#### Real-time Updates

```
Connection: ws://localhost:3001/ws?token=<jwt_token>

Events:
- trade_executed: { tradeId: string, status: string, details: object }
- position_updated: { assetId: string, position: Position }
- system_status: { uptime: number, activeTrades: number }
```

### 4.3 API Response Format

#### Standard Response Structure

```typescript
interface ApiResponse<T = any> {
  success: boolean;
  data?: T;
  error?: string;
  timestamp: number;
}
```

#### Error Response Examples

```json
{
  "success": false,
  "error": "Invalid authentication token",
  "timestamp": 1707091200000
}
```

```json
{
  "success": false,
  "error": "Rate limit exceeded",
  "timestamp": 1707091200000
}
```

### 4.4 Rate Limiting

- **General API**: 100 requests per 15 minutes per user
- **Trading endpoints**: 10 requests per minute
- **Analytics endpoints**: 30 requests per minute
- **Admin endpoints**: 5 requests per minute

Rate limits are enforced using Redis-backed sliding window algorithm.

---

## 5. Security Architecture

### 5.1 Authentication & Authorization

#### JWT-Based Authentication

```typescript
interface JWTPayload {
  address: string;    // Ethereum wallet address
  role: 'admin' | 'user';
  iat: number;        // Issued at timestamp
  exp: number;        // Expiration timestamp (24 hours)
}
```

#### Role-Based Access Control

- **User Role**: Read-only access to personal data and analytics
- **Admin Role**: Full access including trading controls and system management

#### API Key Management (Future)

- Separate API keys for programmatic access
- Scoped permissions (read/write/admin)
- Automatic rotation and expiration

### 5.2 Input Validation & Sanitization

#### Request Validation

- **JSON Schema Validation**: All API endpoints validate request structure
- **Type Safety**: TypeScript strict mode prevents type-related vulnerabilities
- **Parameter Sanitization**: All user inputs sanitized before processing

#### Database Security

- **Schema Validation**: Mongoose schemas enforce data structure
- **Input Sanitization**: All database queries use parameterized statements
- **Access Control**: Database users have minimal required permissions

### 5.3 Encryption & Data Protection

#### Data at Rest

- **Database Encryption**: MongoDB field-level encryption for sensitive data
- **File Encryption**: Configuration files encrypted using AES-256
- **Backup Encryption**: All backups encrypted before storage

#### Data in Transit

- **TLS 1.3**: All API communications encrypted
- **Certificate Pinning**: API clients pin server certificates
- **WebSocket Security**: WSS protocol with token-based authentication

### 5.4 Blockchain Security

#### Transaction Security

- **Gas Optimization**: Dynamic gas pricing to prevent failed transactions
- **Nonce Management**: Sequential nonce handling prevents replay attacks
- **Transaction Simulation**: All transactions simulated before submission

#### Wallet Security

- **Key Management**: Hardware Security Module (HSM) integration (future)
- **Multi-signature**: Gnosis Safe support for high-value operations
- **Cold Storage**: Large holdings moved to cold storage automatically

### 5.5 Monitoring & Audit

#### Security Monitoring

- **Intrusion Detection**: Real-time monitoring for suspicious activities
- **Log Analysis**: Automated analysis of security events
- **Alert System**: Immediate alerts for security incidents

#### Audit Trail

- **Comprehensive Logging**: All security events logged with full context
- **Immutable Audit Log**: Blockchain-based audit trail for critical operations
- **Regular Audits**: Third-party security audits every 6 months

---

## 6. Performance Design

### 6.1 Performance Targets

| Component | Target | Critical Threshold |
|-----------|--------|-------------------|
| API Response Time | <100ms P95 | <500ms P95 |
| Trade Detection | <5 seconds | <30 seconds |
| Order Execution | <10 seconds | <60 seconds |
| Database Query | <50ms P95 | <200ms P95 |
| WebSocket Latency | <100ms | <500ms |

### 6.2 Database Optimization

#### Indexing Strategy

```javascript
// Trade collection indexes
db.user_activities.createIndex({ timestamp: -1 });
db.user_activities.createIndex({ lifecycleState: 1, claimedAt: 1 });
db.user_activities.createIndex({ asset: 1, conditionId: 1 });
db.user_activities.createIndex({ idempotencyKey: 1 }, { unique: true });

// Position collection indexes
db.user_positions.createIndex({ proxyWallet: 1, asset: 1 });
db.user_positions.createIndex({ conditionId: 1 });
```

#### Query Optimization

- **Read/Write Separation**: Separate read replicas for analytics queries
- **Connection Pooling**: Optimized connection pooling with health checks
- **Query Caching**: Redis caching for frequently accessed data

### 6.3 Caching Strategy

#### Application Cache (Redis)

```typescript
// Trade data cache (TTL: 30 seconds)
const TRADE_CACHE_KEY = 'trades:${userAddress}:${limit}:${offset}';
const TRADE_CACHE_TTL = 30;

// Position data cache (TTL: 10 seconds)
const POSITION_CACHE_KEY = 'positions:${userAddress}';
const POSITION_CACHE_TTL = 10;

// Market data cache (TTL: 60 seconds)
const MARKET_CACHE_KEY = 'market:${conditionId}';
const MARKET_CACHE_TTL = 60;
```

#### Database Cache

- **Query Result Cache**: Frequently accessed analytics cached in Redis
- **Session Cache**: User sessions cached to reduce database load
- **Configuration Cache**: System configuration cached for fast access

### 6.4 Horizontal Scaling

#### Load Balancing

- **API Load Balancer**: Nginx with sticky sessions for WebSocket
- **Database Sharding**: MongoDB sharding by user address
- **Microservices**: Independent scaling of trade engine and API server

#### Auto-scaling

- **CPU-based Scaling**: Scale up when CPU > 70%
- **Request-based Scaling**: Scale based on request queue length
- **Time-based Scaling**: Scale during peak trading hours

### 6.5 Monitoring & Alerting

#### Performance Metrics

```typescript
interface PerformanceMetrics {
  api: {
    responseTime: Histogram;
    errorRate: Counter;
    throughput: Counter;
  };
  trading: {
    detectionLatency: Histogram;
    executionTime: Histogram;
    successRate: Counter;
  };
  database: {
    queryTime: Histogram;
    connectionCount: Gauge;
    lockWaitTime: Histogram;
  };
}
```

#### Alert Thresholds

- **API Response Time**: Alert if P95 > 200ms for 5 minutes
- **Error Rate**: Alert if > 5% errors for 10 minutes
- **Database Latency**: Alert if P95 > 100ms for 5 minutes
- **Trade Success Rate**: Alert if < 95% for 30 minutes

---

## 7. Error Handling & Resilience

### 7.1 Error Classification

#### Business Logic Errors

```typescript
enum BusinessError {
  INSUFFICIENT_BALANCE = 'insufficient_balance',
  MARKET_NOT_VIABLE = 'market_not_viable',
  POSITION_TOO_SMALL = 'position_too_small',
  TRADE_ALREADY_EXECUTED = 'trade_already_executed',
  LEASE_ACQUISITION_FAILED = 'lease_acquisition_failed'
}
```

#### System Errors

```typescript
enum SystemError {
  DATABASE_CONNECTION_FAILED = 'database_connection_failed',
  BLOCKCHAIN_RPC_ERROR = 'blockchain_rpc_error',
  EXTERNAL_API_UNAVAILABLE = 'external_api_unavailable',
  RATE_LIMIT_EXCEEDED = 'rate_limit_exceeded'
}
```

### 7.2 Error Handling Strategy

#### API Layer Error Handling

```typescript
app.use((error: Error, req: Request, res: Response, next: NextFunction) => {
  // Log error with context
  logger.error('API Error', {
    error: error.message,
    stack: error.stack,
    url: req.url,
    method: req.method,
    user: req.user?.address
  });

  // Determine error type and response
  const isOperational = error instanceof OperationalError;

  if (isOperational) {
    // Known operational error
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message,
      timestamp: Date.now()
    });
  } else {
    // Unknown error - don't leak details
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      timestamp: Date.now()
    });
  }
});
```

#### Trade Engine Error Handling

```typescript
try {
  const result = await executeOrderGuarded(ctx, request);
  await updateTradeState(UserActivity, tradeId, result);
} catch (error) {
  // Log critical error
  logger.error('Trade execution failed', {
    tradeId,
    error: error.message,
    stack: error.stack
  });

  // Mark as failed with retry logic
  await updateTradeState(UserActivity, tradeId, {
    state: 'failed',
    reason: error.message,
    isRetryable: isRetryableError(error)
  });
}
```

### 7.3 Circuit Breaker Pattern

#### External API Circuit Breaker

```typescript
class CircuitBreaker {
  private failures = 0;
  private lastFailureTime = 0;
  private state: 'CLOSED' | 'OPEN' | 'HALF_OPEN' = 'CLOSED';

  async execute<T>(operation: () => Promise<T>): Promise<T> {
    if (this.state === 'OPEN') {
      if (Date.now() - this.lastFailureTime > this.timeout) {
        this.state = 'HALF_OPEN';
      } else {
        throw new Error('Circuit breaker is OPEN');
      }
    }

    try {
      const result = await operation();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }
}
```

### 7.4 Retry Mechanisms

#### Exponential Backoff

```typescript
async function retryWithBackoff<T>(
  operation: () => Promise<T>,
  maxRetries: number = 3,
  baseDelay: number = 1000
): Promise<T> {
  let lastError: Error;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error as Error;

      if (attempt === maxRetries) {
        throw lastError;
      }

      const delay = baseDelay * Math.pow(2, attempt);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  throw lastError!;
}
```

### 7.5 Graceful Shutdown

#### Process Signal Handling

```typescript
process.on('SIGTERM', async () => {
  logger.info('Received SIGTERM, initiating graceful shutdown');

  // Stop accepting new requests
  server.close();

  // Wait for ongoing operations to complete
  await Promise.all([
    tradeExecutor.stopTradeExecutor(),
    tradeMonitor.stopTradeMonitor(),
    database.disconnect()
  ]);

  logger.info('Graceful shutdown completed');
  process.exit(0);
});
```

---

## 8. Testing Strategy

### 8.1 Test Pyramid

#### Unit Tests (70% of tests)

- **Component Logic**: Individual functions and classes
- **Business Rules**: Safety guards, validation logic
- **Data Transformation**: Schema validation, data processing

#### Integration Tests (20% of tests)

- **API Endpoints**: Full request/response cycle
- **Database Operations**: CRUD operations with real database
- **External APIs**: Mocked external service interactions

#### End-to-End Tests (10% of tests)

- **Critical User Journeys**: Complete trading workflows
- **System Integration**: Full stack testing with real dependencies
- **Performance Testing**: Load testing and stress testing

### 8.2 Safety Testing

#### Guard Rail Testing

```typescript
describe('Safety Guards', () => {
  describe('Market Viability', () => {
    it('blocks trades in unresolved markets', async () => {
      // Mock market data for unresolved market
      const mockMarketData = { /* extreme price data */ };

      const result = await checkMarketViability(mockMarketData);

      expect(result.viable).toBe(false);
      expect(result.reason).toContain('unresolved');
    });

    it('blocks trades with insufficient liquidity', async () => {
      // Mock market data with thin liquidity
      const mockMarketData = { /* low depth data */ };

      const result = await checkMarketViability(mockMarketData);

      expect(result.viable).toBe(false);
      expect(result.reason).toContain('liquidity');
    });
  });

  describe('Slippage Protection', () => {
    it('blocks trades exceeding slippage threshold', async () => {
      const request = {
        side: 'BUY',
        amount: 100,
        traderPrice: 0.50,
        // Current market price 20% higher
        currentPrice: 0.60
      };

      const result = await checkSlippageGate(request);

      expect(result.passed).toBe(false);
      expect(result.reason).toContain('slippage');
    });
  });
});
```

#### Mutation Testing

```typescript
describe('Mutation Testing', () => {
  it('detects when viability guard is removed', async () => {
    // Temporarily disable viability check
    const originalCheckViability = checkMarketViability;
    checkMarketViability = jest.fn().mockResolvedValue({ viable: true });

    // This test should fail if the guard is actually disabled in production
    const request = { /* invalid trade */ };
    const result = await executeOrderGuarded(ctx, request);

    expect(result.skipped).toBe(true);
    expect(result.reason).toBe('market_not_viable');

    // Restore original function
    checkMarketViability = originalCheckViability;
  });
});
```

### 8.3 Performance Testing

#### Load Testing

```typescript
describe('Performance Tests', () => {
  it('handles 100 concurrent API requests', async () => {
    const requests = Array(100).fill().map(() =>
      axios.get('/api/positions', { headers: { Authorization: `Bearer ${token}` } })
    );

    const startTime = Date.now();
    const responses = await Promise.all(requests);
    const endTime = Date.now();

    // All requests should succeed
    responses.forEach(response => {
      expect(response.status).toBe(200);
    });

    // Average response time should be < 100ms
    const avgResponseTime = (endTime - startTime) / 100;
    expect(avgResponseTime).toBeLessThan(100);
  });
});
```

### 8.4 Test Data Management

#### Test Database Setup

```typescript
beforeAll(async () => {
  // Connect to test database
  await mongoose.connect(process.env.TEST_MONGODB_URI);

  // Clear all collections
  const collections = mongoose.connection.collections;
  for (const key in collections) {
    await collections[key].deleteMany({});
  }
});

afterAll(async () => {
  // Disconnect from test database
  await mongoose.disconnect();
});
```

#### Mock Data Factory

```typescript
const createMockTrade = (overrides: Partial<UserActivityInterface> = {}): UserActivityInterface => ({
  _id: new mongoose.Types.ObjectId(),
  proxyWallet: '0x1234567890123456789012345678901234567890',
  timestamp: Date.now() / 1000,
  conditionId: 'test-condition',
  type: 'TRADE',
  size: 100,
  usdcSize: 50,
  transactionHash: '0xabcdef1234567890',
  price: 0.5,
  asset: 'test-asset',
  side: 'BUY',
  outcomeIndex: 0,
  title: 'Test Market',
  slug: 'test-market',
  eventSlug: 'test-event',
  outcome: 'Yes',
  ...overrides
});
```

---

## 9. Deployment & Operations

### 9.1 Infrastructure Architecture

#### Production Environment

```
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│   Load Balancer │    │   API Servers   │    │   Cache Layer   │
│    (Nginx)      │────│   (Node.js)     │────│    (Redis)      │
└─────────────────┘    └─────────────────┘    └─────────────────┘
         │                       │                       │
         ▼                       ▼                       ▼
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│   Database      │    │   Monitoring    │    │   Blockchain    │
│   (MongoDB)     │    │   (Datadog)     │    │   (Polygon)     │
└─────────────────┘    └─────────────────┘    └─────────────────┘
```

#### Scaling Strategy

- **Horizontal Scaling**: Auto-scaling groups for API servers
- **Database Scaling**: MongoDB replica sets with read replicas
- **Cache Scaling**: Redis cluster for high availability
- **Load Balancing**: Round-robin with health checks

### 9.2 Deployment Pipeline

#### CI/CD Pipeline

```yaml
stages:
  - test
  - security
  - build
  - deploy

test:
  script:
    - npm ci
    - npm run lint
    - npm test
    - npm run test:coverage

security:
  script:
    - npm audit --audit-level high
    - npm run guard:chokepoint

build:
  script:
    - npm run build
    - docker build -t polycopy:$CI_COMMIT_SHA .

deploy:
  script:
    - kubectl set image deployment/polycopy-api polycopy=$CI_COMMIT_SHA
    - kubectl rollout status deployment/polycopy-api
```

### 9.3 Configuration Management

#### Environment Variables

```bash
# Database
MONGODB_URI=mongodb+srv://username:password@cluster.mongodb.net/polycopy_prod

# API Configuration
API_PORT=3001
API_HOST=0.0.0.0
JWT_SECRET=your-production-jwt-secret

# Trading Configuration
USER_ADDRESSES=0x123...,0x456...
PROXY_WALLET=0x789...

# Security
CORS_ORIGIN=https://app.polycopy.com
ENABLE_API_DOCS=false

# Monitoring
DATADOG_API_KEY=your-datadog-key
SENTRY_DSN=your-sentry-dsn
```

### 9.4 Backup & Recovery

#### Database Backup

```bash
# Daily backup script
mongodump --db polycopy_prod --out /backup/$(date +%Y%m%d)
aws s3 sync /backup s3://polycopy-backups/database/

# Point-in-time recovery
mongorestore --db polycopy_prod /backup/20231201/polycopy_prod
```

#### Application Backup

```bash
# Configuration backup
aws s3 cp /etc/polycopy/config.env s3://polycopy-backups/config/

# Log backup
aws s3 sync /var/log/polycopy s3://polycopy-backups/logs/
```

### 9.5 Monitoring & Alerting

#### Application Monitoring

```typescript
// Health check endpoint
app.get('/health', (req, res) => {
  const health = {
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    database: await checkDatabaseHealth(),
    blockchain: await checkBlockchainHealth()
  };

  res.json(health);
});
```

#### Infrastructure Monitoring

- **Server Metrics**: CPU, memory, disk usage
- **Application Metrics**: Response times, error rates, throughput
- **Database Metrics**: Connection count, query performance, replication lag
- **Blockchain Metrics**: Gas prices, transaction success rates

### 9.6 Incident Response

#### Incident Response Plan

1. **Detection**: Automated monitoring alerts
2. **Assessment**: Determine impact and severity
3. **Communication**: Notify stakeholders and users
4. **Containment**: Stop the bleeding (circuit breakers, rollbacks)
5. **Recovery**: Restore service with minimal data loss
6. **Analysis**: Root cause analysis and lessons learned
7. **Prevention**: Implement fixes and monitoring improvements

#### Rollback Procedure

```bash
# Emergency rollback to previous version
kubectl rollout undo deployment/polycopy-api

# Verify rollback success
kubectl rollout status deployment/polycopy-api

# Monitor for issues
kubectl logs -f deployment/polycopy-api
```

---

## 10. Appendices

### Appendix A: Database Migration Scripts

### Appendix B: API Endpoint Specifications

### Appendix C: Security Audit Checklist

### Appendix D: Performance Benchmark Results

### Appendix E: Disaster Recovery Procedures

---

## Conclusion

This Software Design Document provides the comprehensive technical foundation for the PolyCopy platform. The architecture emphasizes safety, performance, and maintainability while supporting the business requirements outlined in the PRD.

Key design principles:

1. **Zero-Compromise Safety**: Single choke point with independent guard rails
2. **Performance First**: Sub-second execution with horizontal scaling
3. **Complete Transparency**: Open-source backend with comprehensive logging
4. **Production Ready**: Enterprise-grade monitoring, security, and operations

The implementation follows these principles through:
- Comprehensive error handling and resilience patterns
- Extensive testing strategy with safety-focused test cases
- Production-ready deployment and operations procedures
- Security-first architecture with multiple layers of protection

This SDD serves as the authoritative technical specification for all development, testing, and operations activities.