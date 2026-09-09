# HA Deployment Guide

## Architecture Overview

```
                    ┌──────────────────────────────────────┐
                    │           Shared Lock Volume          │
                    │        /var/lock/vrf-oracle.lock      │
                    └──────────────┬───────────────────────┘
                                   │
                    ┌──────────────┴───────────────────────┐
                    │                                       │
          ┌─────────▼──────────┐              ┌────────────▼────────┐
          │   oracle-primary   │              │   oracle-standby    │
          │   (LEADER)         │              │   (STANDBY)         │
          │   :8080            │              │   :8081             │
          │                    │              │                     │
          │ ✓ Holds lock       │              │ ✗ Watches lock      │
          │ ✓ Submits TXs      │              │ ✗ No TX submission  │
          │ ✓ Renews every 10s │              │ ✓ Polls every 5s    │
          └────────────────────┘              └─────────────────────┘
                    │                                       │
                    └───────────────┬───────────────────────┘
                                    │
                         ┌──────────▼──────────┐
                         │   Stellar Testnet   │
                         │   VRF Contract      │
                         └─────────────────────┘
```

## Leader Election Protocol

1. **Startup**: Both nodes try to acquire the lock file
2. **Lock format**: `{"pid": 1234, "instanceId": "oracle-primary", "timestamp": 1694000000}`
3. **Lock TTL**: 30 seconds — if not renewed, lock is considered stale
4. **Heartbeat**: Leader renews lock every 10 seconds
5. **Failover**: Standby detects stale lock (age > 30s) and takes over
6. **Prevention**: Only the lock holder submits `fulfill()` transactions

## Failover Timing

| Event | Time |
|---|---|
| Primary crashes | T+0 |
| Lock becomes stale | T+30s (LOCK_TTL) |
| Standby detects stale lock | T+30-35s |
| Standby acquires lock | T+35s |
| Standby starts fulfilling | T+35s |
| **Maximum gap in service** | **~35 seconds** |

## Single-Server Setup

Both containers on the same machine share the lock via a Docker volume:

```bash
docker compose -f docker-compose.ha.yml up -d
```

## Multi-Server Setup

For true geographic redundancy, use Redis-based locking:

```bash
# Install Redis
docker run -d --name redis -p 6379:6379 redis:7-alpine

# Set in .env:
# LEADER_BACKEND=redis
# REDIS_URL=redis://redis:6379
```

> Note: Redis-based leader election requires the `ioredis` package.
> File-based locking is sufficient for single-server HA.

## Monitoring HA State

```bash
# Both instances
watch -n 5 'curl -s http://localhost:8080/status | jq .role; \
            curl -s http://localhost:8081/status | jq .role'
```

Expected output:
```
"leader"
"standby"
```

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `INSTANCE_ID` | `oracle-<pid>` | Unique name for this node |
| `LEADER_LOCK_FILE` | `/tmp/vrf-oracle.lock` | Path to lock file |
| `LEADER_LOCK_TTL_MS` | `30000` | Lock expiry in ms |
| `LEADER_HEARTBEAT_MS` | `10000` | How often leader renews lock |
| `LEADER_POLL_MS` | `5000` | How often standby checks lock |
| `HEALTH_PORT` | `8080` | HTTP health/metrics port |
