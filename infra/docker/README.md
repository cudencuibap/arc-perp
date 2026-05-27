# Docker Notes

The root `Dockerfile` builds all workspaces once, then each Compose service starts a different package entry point.

Useful commands:

```bash
docker compose build
docker compose up matching-engine websocket-gateway price-engine market-makers traders
```

Published ports:

- `4101`: matching engine REST and upstream WebSocket `/stream`
- `4100`: public gateway REST and WebSocket `/ws`
- `4173`: built DEX web preview
- `5174`: admin panel dev server
