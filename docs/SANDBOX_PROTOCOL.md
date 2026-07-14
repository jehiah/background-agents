# Generic Sandbox Protocol

The generic sandbox backend lets Open-Inspect drive any sandbox host that speaks a small HTTP
protocol, instead of an SDK-specific provider (Modal, Daytona, Vercel, OpenComputer, E2B). Point the
control plane at a base URL, give it a bearer token, and declare which operations the backend
implements.

The control plane side lives in `packages/control-plane/src/sandbox/generic-client.ts` (wire format)
and `packages/control-plane/src/sandbox/providers/generic-provider.ts` (capability gating). Those
files are the source of truth; this document describes what a conforming backend must expose.

## Configuration

| Setting                                  | Env (Node host)                            | Terraform variable                         | Default |
| ---------------------------------------- | ------------------------------------------ | ------------------------------------------ | ------- |
| Base URL                                 | `GENERIC_SANDBOX_URL`                      | `generic_sandbox_url`                      | —       |
| Bearer token                             | `GENERIC_SANDBOX_TOKEN`                    | `generic_sandbox_token`                    | —       |
| Backend enforces the sandbox lifetime    | `GENERIC_SANDBOX_SUPPORTS_SANDBOX_TIMEOUT` | `generic_sandbox_supports_sandbox_timeout` | `true`  |
| Backend implements filesystem snapshots  | `GENERIC_SANDBOX_SUPPORTS_SNAPSHOTS`       | `generic_sandbox_supports_snapshots`       | `false` |
| Backend implements restore-from-snapshot | `GENERIC_SANDBOX_SUPPORTS_RESTORE`         | `generic_sandbox_supports_restore`         | `false` |
| Backend implements persistent resume     | `GENERIC_SANDBOX_SUPPORTS_RESUME`          | `generic_sandbox_supports_resume`          | `true`  |
| Backend implements explicit stop         | `GENERIC_SANDBOX_SUPPORTS_STOP`            | `generic_sandbox_supports_stop`            | `true`  |

Set `SANDBOX_PROVIDER=generic` (`sandbox_provider = "generic"`) to select the backend.

The defaults describe a persistent, VM-style host: it honours the lifetime it is given, resumes and
stops instances in place, and has no snapshots. A capability that is off is never exercised — the
provider does not even expose the corresponding method, and the lifecycle manager gates on method
presence, so an unimplemented endpoint is never called.

## Transport

- Every operation is a `POST` of a JSON body to a path under the configured base URL. A trailing
  slash on the base URL is stripped.
- Authentication is `Authorization: Bearer <token>` on every request except `/health`.
- Correlation headers are forwarded when present: `x-trace-id`, `x-request-id`, `x-session-id`,
  `x-sandbox-id`.
- Field names are `snake_case`. Optional fields are sent explicitly as `null` rather than omitted.
- The provider handle is `provider_object_id` — the backend's own identifier for the running
  instance. The control plane stores it and sends it back on snapshot, resume, and stop. **A create
  response without it produces a sandbox that can never be stopped**, so return one whenever the
  backend can address the instance at all.

### Response envelope

Every response is

```json
{ "success": true, "data": { ... } }
```

or

```json
{ "success": false, "error": "human-readable reason" }
```

A non-2xx HTTP status is an error regardless of the body; the numeric status is preserved so the
control plane can tell a transient failure from a permanent one. On `/sandbox/create`, a
`success: false` envelope is also an error — create either produces a sandbox or fails. The other
operations map `success: false` to a failure result the lifecycle manager handles (for example, a
failed resume falls back to a fresh create).

### Timeouts

The client abandons a request after a per-operation deadline: 210s for create, restore and resume;
120s for snapshot and stop; 15s for health. A backend that provisions more slowly than this should
return promptly and report readiness over the runtime WebSocket instead.

## Operations

### `POST /sandbox/create`

Request:

```json
{
  "session_id": "sess-1",
  "sandbox_id": "sandbox-acme-widgets-1737000000",
  "repo_owner": "acme",
  "repo_name": "widgets",
  "repositories": [{ "repo_owner": "acme", "repo_name": "widgets", "branch": "main" }],
  "control_plane_url": "https://control-plane.example.workers.dev",
  "sandbox_auth_token": "…",
  "agent_session_id": null,
  "harness": "claude",
  "provider": "anthropic",
  "model": "claude-sonnet-4-6",
  "user_env_vars": null,
  "prebuilt_image_id": null,
  "prebuilt_image_sha": null,
  "timeout_seconds": 7200,
  "branch": null,
  "code_server_enabled": false,
  "agent_slack_notify_enabled": false,
  "mcp_servers": null,
  "sandbox_settings": null
}
```

`repo_owner`/`repo_name` are `null` for repo-less (environment-only) sessions. `repo_owner` may
itself contain `/` (GitLab subgroups); only `repo_name` is a single path segment, and it is the
checkout directory under `/workspace`. `repositories` is the ordered member list for multi-repo
sessions, whose first entry mirrors `repo_owner`/`repo_name`.

Response `data`:

```json
{
  "sandbox_id": "sandbox-acme-widgets-1737000000",
  "provider_object_id": "vm-instance-abc123",
  "status": "connecting",
  "created_at": 1737000000000,
  "code_server_url": null,
  "code_server_password": null,
  "ttyd_url": null,
  "tunnel_urls": null
}
```

The sandbox boots the runtime, which connects back to `control_plane_url` over a WebSocket
authenticated with `sandbox_auth_token`. The control plane owns the session's status from that point
on, so `status` is informational.

### `POST /sandbox/restore` (capability: restore)

Restores a snapshot into a new instance. The session fields are nested under `session_config`:

```json
{
  "snapshot_image_id": "snap-abc123",
  "session_config": {
    "session_id": "sess-1",
    "repo_owner": "acme",
    "repo_name": "widgets",
    "repositories": null,
    "provider": "anthropic",
    "model": "claude-sonnet-4-6",
    "branch": null,
    "mcp_servers": null
  },
  "sandbox_id": "sandbox-acme-widgets-1737000100",
  "control_plane_url": "https://control-plane.example.workers.dev",
  "sandbox_auth_token": "…",
  "user_env_vars": null,
  "timeout_seconds": 7200,
  "code_server_enabled": false,
  "agent_slack_notify_enabled": false,
  "sandbox_settings": null
}
```

Response `data`: `sandbox_id`, `provider_object_id`, and the same optional access fields as create.

### `POST /sandbox/snapshot` (capability: snapshots)

```json
{
  "provider_object_id": "vm-instance-abc123",
  "session_id": "sess-1",
  "reason": "inactivity_timeout"
}
```

Response `data` must carry `image_id`; a response without one is treated as a failed snapshot.

### `POST /sandbox/resume` (capability: resume)

```json
{
  "provider_object_id": "vm-instance-abc123",
  "session_id": "sess-1",
  "sandbox_id": "sandbox-acme-widgets-1737000000",
  "timeout_seconds": 7200,
  "code_server_enabled": false,
  "sandbox_settings": null
}
```

Response `data`: `provider_object_id` (send the new one if recovery moved the instance),
`should_spawn_fresh`, and the optional access fields. `should_spawn_fresh: true` on a failed resume
tells the control plane the saved instance is gone and it should create a new sandbox instead of
retrying — include it in the `data` of the `success: false` envelope.

### `POST /sandbox/stop` (capability: stop)

```json
{
  "provider_object_id": "vm-instance-abc123",
  "session_id": "sess-1",
  "reason": "session_archived",
  "intent": "preserve"
}
```

No response data is read; only the envelope matters.

`intent` is `"preserve"` or `"destroy"`. With `"preserve"` the instance must stay resumable — the
control plane stops on inactivity or archive and resumes the same instance on the next prompt. With
`"destroy"` the instance will never be resumed (the session was cancelled, or the sandbox is being
replaced) and the backend should release it. A backend that supports stop but not resume may destroy
on either intent; the control plane takes a snapshot first when snapshots are available.

### `GET /health`

Unauthenticated liveness check. Returns the standard envelope with `data: { "status": "ok" }`.

## Lifetimes

The protocol has no expiry field. When the backend enforces sandbox timeouts, the control plane
treats `timeout_seconds` (default `DEFAULT_SANDBOX_TIMEOUT_SECONDS`) as a conservative start bound
for the instance's lifetime; when it does not, the instance is taken to have no expiry. A backend
that enforces a different lifetime than the one requested should instead be configured with
`GENERIC_SANDBOX_SUPPORTS_SANDBOX_TIMEOUT=false`.
