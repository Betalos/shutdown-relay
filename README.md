# shutdown-relay

A tiny HTTP relay that lets an automation tool (n8n) shut a TrueNAS SCALE server down **without holding a powerful credential**.
TrueNAS has no shutdown-only API role and its API keys cannot be limited to one method, so the Full Admin API key lives
only in this container; callers get a token that can do exactly one thing.

```bash
docker run -p 8080:8080 \
  -e RELAY_TOKEN=<what callers send> \
  -e TRUENAS_API_KEY=<API key of a Full Admin user> \
  -e TRUENAS_URL=https://truenas.example.com \
  ghcr.io/<owner>/shutdown-relay:latest
```

| Env | |
|---|---|
| `RELAY_TOKEN` | required, the bearer token callers must send |
| `TRUENAS_API_KEY` | required, API key of a TrueNAS user that may call `system.shutdown` (Full Admin) |
| `TRUENAS_URL` | required, TrueNAS base URL, e.g. `https://truenas.example.com`; must serve a certificate the container trusts |
| `SHUTDOWN_DELAY` | seconds between the request and the shutdown (default `15`) |
| `RELAY_PORT` | default `8080` |

## API

`GET /health` (no auth), and

```
POST /shutdown     Authorization: Bearer <RELAY_TOKEN>
{"reason": "idle for 30 min"}              -> shuts down after SHUTDOWN_DELAY
{"dry_run": true}                          -> checks key and permission, shuts nothing down
```

It talks JSON-RPC 2.0 over WebSocket (`/api/current`), because TrueNAS removes the REST API in 26.04.
`dry_run` sends a deliberately invalid `system.shutdown` (empty reason, non-integer delay); TrueNAS accepts it as a job
which must end `FAILED` with `EINVAL`. If it ever ends otherwise the relay aborts the job and reports a failure.

Put TLS in front of it (a reverse proxy): the token travels in a header.

## Releases

Pushes to `main` publish `ghcr.io/<owner>/shutdown-relay:latest` and `:sha-…`; tags `v1.2.3` publish `1.2.3` and `1.2`.
