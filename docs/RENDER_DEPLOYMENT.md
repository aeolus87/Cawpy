# Render Deployment Guide

This guide covers deploying the Polymarket Copy Trading Bot to Render with web-based configuration.

## 🚀 Quick Deploy to Render

### 1. Fork/Clone Repository

```bash
git clone https://github.com/aeolus87/Cawpy.git
cd Cawpy
```

### 2. Create Render Account

1. Go to [render.com](https://render.com)
2. Sign up/Sign in
3. Connect your GitHub account

### 3. Create New Web Service

1. Click **"New"** → **"Web Service"**
2. Connect your GitHub repository
3. Configure the service:

#### **Service Configuration:**
```
Name: polymarket-copy-bot
Environment: Node
Build Command: npm run build
Start Command: npm run start:render
```

#### **Environment Variables (Required):**

| Variable | Value | Description |
|----------|-------|-------------|
| `MONGO_URI` | `mongodb+srv://...` | MongoDB Atlas connection string |
| `JWT_SECRET` | `your-secure-random-string` | JWT secret (32+ characters) |
| `ENABLE_API` | `true` | Enable API server |
| `CORS_ORIGIN` | `*` | Allow all origins (update for production) |

#### **Optional Environment Variables:**

| Variable | Default | Description |
|----------|---------|-------------|
| `API_PORT` | `10000` | Render uses 10000 by default |
| `API_HOST` | `0.0.0.0` | Bind to all interfaces |
| `ENABLE_API_DOCS` | `true` | Enable Swagger docs |

### 4. Deploy

1. Click **"Create Web Service"**
2. Wait for deployment (5-10 minutes)
3. Your API will be available at: `https://your-service.onrender.com`

## 🔧 Post-Deployment Setup

### 1. Access API Documentation

Visit: `https://your-service.onrender.com/api-docs`

### 2. Initial Configuration

Since no user configuration is set, you'll need to configure the bot through the API:

#### **Option A: Use Swagger UI**
1. Go to `/api-docs`
2. Use the `/api/config/setup` endpoint
3. Provide your wallet, traders, and settings

#### **Option B: Use curl/Postman**
```bash
# 1. Get authentication (you'll need to implement wallet signing)
curl -X POST https://your-service.onrender.com/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{
    "address": "0x...",
    "signature": "signature..."
  }'

# 2. Complete setup
curl -X POST https://your-service.onrender.com/api/config/setup \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "proxyWallet": "0x...",
    "privateKey": "0x...",
    "userAddresses": ["0xTrader1", "0xTrader2"],
    "mongoUri": "mongodb://...",
    "rpcUrl": "https://polygon-rpc.com"
  }'
```

### 3. Verify Configuration

```bash
# Check bot configuration
curl -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  https://your-service.onrender.com/api/config

# Check bot status
curl -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  https://your-service.onrender.com/api/trading/status
```

## 🌐 Frontend Integration

### Environment Variables for Frontend:

```env
VITE_API_URL=https://your-service.onrender.com
VITE_WS_URL=wss://your-service.onrender.com
```

### Frontend Architecture:

```
src/
├── components/
│   ├── SetupWizard.tsx     # Initial bot configuration
│   ├── TraderManager.tsx   # Add/remove traders
│   ├── Dashboard.tsx       # Real-time P&L
│   ├── SettingsPanel.tsx   # Trading parameters
│   └── WalletConnector.tsx # Authentication
├── hooks/
│   ├── useAuth.ts         # JWT management
│   ├── useConfig.ts       # Bot configuration
│   ├── useWebSocket.ts    # Real-time updates
│   └── useTraders.ts      # Trader management
└── stores/
    ├── auth.store.ts      # Authentication state
    ├── config.store.ts    # Bot configuration
    └── trading.store.ts   # Trading state
```

## 🔐 Security Considerations

### Production CORS Settings:
```env
CORS_ORIGIN=https://yourdomain.com
```

### JWT Secret:
- Use a cryptographically secure random string
- Minimum 32 characters
- Regenerate for production

### API Rate Limiting:
- Built-in rate limiting protects against abuse
- Admin endpoints: 5 requests/minute
- Trading endpoints: 10 requests/minute

## 📊 Monitoring & Logs

### Render Dashboard:
- View real-time logs in Render dashboard
- Monitor CPU/memory usage
- Set up health checks

### Health Check Endpoint:
```bash
curl https://your-service.onrender.com/health
```

## 🛠️ Troubleshooting

### Common Issues:

#### **"Missing required infrastructure variables"**
- Ensure `MONGO_URI` and `JWT_SECRET` are set in Render environment variables

#### **"CORS errors"**
- Check `CORS_ORIGIN` setting matches your frontend domain

#### **"Authentication failed"**
- Verify JWT secret is consistent
- Check token expiration (24 hours default)

#### **"Configuration not persisting"**
- Ensure MongoDB connection is working
- Check database permissions

### Debug Commands:

```bash
# Check service logs
render logs your-service-name

# Restart service
render restart your-service-name

# Check environment variables
render env ls your-service-name
```

## 💰 Render Pricing

- **Free Tier**: 750 hours/month, suitable for development
- **Paid Plans**: From $7/month for production use
- **Auto-scaling**: Scale based on traffic

## 🔄 Updates & Deployment

### Automatic Deployments:
1. Push changes to `main` branch
2. Render automatically rebuilds and deploys
3. Zero-downtime deployments

### Manual Deployment:
```bash
git push origin main
# Render detects changes and deploys automatically
```

## 📞 Support

For deployment issues:
1. Check Render logs
2. Verify environment variables
3. Test API endpoints with curl
4. Review this documentation

The bot is now running on Render with full web-based configuration! 🎉