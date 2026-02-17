# Deployment Guide

This guide covers deploying Koryphaios to production environments.

---

## Prerequisites

- Server with Bun 1.0+ installed
- Domain name (optional, for HTTPS)
- Reverse proxy (nginx or Caddy recommended)
- At least 512MB RAM, 1GB+ recommended
- Node.js 18+ (for build compatibility)

---

## Production Build

### 1. Install Dependencies

```bash
# On your server
git clone <repository-url>
cd Koryphaios
bun install
```

### 2. Configure Environment

```bash
# Copy and edit environment variables
cp .env.example .env
nano .env  # Add your API keys

# Configure koryphaios.json
cp config.example.json koryphaios.json
nano koryphaios.json  # Set production values
```

### 3. Build Application

```bash
# Build all workspaces
bun run build

# Verify build
bun run check
```

---

## Deployment Options

### Option A: Direct with Bun (Simple)

```bash
# Start backend
cd backend
bun run build/server.js

# Start frontend (separate terminal)
cd frontend/build
bun run index.js
```

**Pros:** Simple, single runtime
**Cons:** No auto-restart, manual process management

---

### Option B: PM2 (Recommended)

```bash
# Install PM2
npm install -g pm2

# Create ecosystem.config.js
cat > ecosystem.config.js << 'EOF'
module.exports = {
  apps: [
    {
      name: 'koryphaios-backend',
      script: 'bun',
      args: 'run backend/build/server.js',
      cwd: '/path/to/Koryphaios',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '500M',
      env: {
        NODE_ENV: 'production'
      }
    },
    {
      name: 'koryphaios-frontend',
      script: 'bun',
      args: 'run frontend/build/index.js',
      cwd: '/path/to/Koryphaios',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '300M',
      env: {
        NODE_ENV: 'production'
      }
    }
  ]
};
EOF

# Start with PM2
pm2 start ecosystem.config.js

# Save configuration
pm2 save

# Setup startup script
pm2 startup
```

**Pros:** Auto-restart, logging, monitoring
**Cons:** Extra dependency

---

### Option C: Systemd Service

```bash
# Create backend service
sudo tee /etc/systemd/system/koryphaios-backend.service << EOF
[Unit]
Description=Koryphaios Backend Server
After=network.target

[Service]
Type=simple
User=www-data
WorkingDirectory=/var/www/koryphaios
ExecStart=/usr/local/bin/bun run backend/build/server.js
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF

# Enable and start
sudo systemctl daemon-reload
sudo systemctl enable koryphaios-backend
sudo systemctl start koryphaios-backend

# Check status
sudo systemctl status koryphaios-backend
```

**Pros:** Native system integration, reliable
**Cons:** Linux-only, more setup

---

## Reverse Proxy Configuration

### Nginx

```nginx
# /etc/nginx/sites-available/koryphaios
server {
    listen 80;
    server_name koryphaios.yourdomain.com;

    # Redirect to HTTPS
    return 301 https://$server_name$request_uri;
}

server {
    listen 443 ssl http2;
    server_name koryphaios.yourdomain.com;

    # SSL certificates (use Let's Encrypt)
    ssl_certificate /etc/letsencrypt/live/koryphaios.yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/koryphaios.yourdomain.com/privkey.pem;

    # Frontend
    location / {
        proxy_pass http://127.0.0.1:5173;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }

    # Backend API
    location /api {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # WebSocket
    location /ws {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_read_timeout 86400;
    }

    # Security headers
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-XSS-Protection "1; mode=block" always;
    add_header Referrer-Policy "no-referrer-when-downgrade" always;
}
```

Enable the site:
```bash
sudo ln -s /etc/nginx/sites-available/koryphaios /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

---

### Caddy (Simpler)

```caddyfile
# /etc/caddy/Caddyfile
koryphaios.yourdomain.com {
    reverse_proxy /api* 127.0.0.1:3000
    reverse_proxy /ws 127.0.0.1:3000
    reverse_proxy 127.0.0.1:5173

    encode gzip

    header {
        X-Frame-Options SAMEORIGIN
        X-Content-Type-Options nosniff
        Referrer-Policy no-referrer-when-downgrade
    }
}
```

Reload:
```bash
sudo systemctl reload caddy
```

---

## SSL/TLS Setup

### Let's Encrypt (Free)

```bash
# Install certbot
sudo apt install certbot python3-certbot-nginx

# Get certificate (nginx)
sudo certbot --nginx -d koryphaios.yourdomain.com

# Auto-renewal
sudo systemctl enable certbot.timer
```

---

## Security Checklist

- [ ] HTTPS enabled with valid certificate
- [ ] Firewall configured (allow 80, 443, block 3000/5173)
- [ ] API keys in `.env`, not committed to git
- [ ] CORS origins updated for production domain
- [ ] Rate limiting enabled
- [ ] Regular security updates (`bun upgrade`, `apt update`)
- [ ] Backups configured for `.koryphaios/` directory
- [ ] Logs monitored (PM2 logs or journalctl)

---

## Monitoring

### PM2 Monitoring

```bash
# View logs
pm2 logs koryphaios-backend
pm2 logs koryphaios-frontend

# Monitor resources
pm2 monit

# Web dashboard
pm2 install pm2-server-monit
```

### System Logs

```bash
# Systemd logs
sudo journalctl -u koryphaios-backend -f

# Nginx logs
sudo tail -f /var/log/nginx/access.log
sudo tail -f /var/log/nginx/error.log
```

---

## Backup & Restore

### Backup

```bash
# Backup session data
tar -czf koryphaios-backup-$(date +%Y%m%d).tar.gz .koryphaios/

# Backup configuration
cp koryphaios.json koryphaios.json.backup
cp .env .env.backup
```

### Restore

```bash
# Restore session data
tar -xzf koryphaios-backup-YYYYMMDD.tar.gz

# Restart services
pm2 restart all
# or
sudo systemctl restart koryphaios-backend
```

---

## Troubleshooting

### Backend won't start
```bash
# Check logs
pm2 logs koryphaios-backend --lines 50

# Verify configuration
cd backend && bun run typecheck

# Test manually
cd backend && bun run build/server.js
```

### WebSocket connection fails
```bash
# Check reverse proxy WebSocket support
curl -i -N -H "Connection: Upgrade" -H "Upgrade: websocket" https://yourdomain.com/ws

# Verify nginx/Caddy WebSocket config
sudo nginx -t
```

### High memory usage
```bash
# Monitor processes
pm2 monit

# Restart if needed
pm2 restart koryphaios-backend

# Adjust max_memory_restart in ecosystem.config.js
```

---

## Environment-Specific Configuration

### Production koryphaios.json

```json
{
  "server": {
    "port": 3000,
    "host": "127.0.0.1"  // Bind to localhost, proxy handles external
  },
  "dataDirectory": "/var/lib/koryphaios/data"
}
```

### Recommended Server Specs

| Users | RAM | CPU | Storage |
|-------|-----|-----|---------|
| 1-5   | 1GB | 1 core | 5GB |
| 5-20  | 2GB | 2 cores | 10GB |
| 20+   | 4GB+ | 4+ cores | 20GB+ |

---

## Updates

```bash
# Pull latest code
git pull origin main

# Install new dependencies
bun install

# Rebuild
bun run build

# Restart services
pm2 restart all
# or
sudo systemctl restart koryphaios-backend
```

---

## Performance Tuning

1. **Enable gzip compression** (nginx/Caddy)
2. **Use HTTP/2** for faster multiplexing
3. **Cache static assets** (frontend build)
4. **Limit concurrent connections** in reverse proxy
5. **Monitor token usage** to avoid API rate limits

---

For more help, see `TROUBLESHOOTING.md` or open an issue.
