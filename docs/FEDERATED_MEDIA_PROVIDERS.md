# Federated Media Providers

PortOS can opt in to serving local media-generation capacity to another registered PortOS peer. The first wire contract, `/api/federation/media/v1`, supports queued audio generation through the existing durable `mediaJobQueue` and local music engines.

This is provider-side infrastructure. A peer can call the contract directly, but automatic provider discovery, selection, failover, and consumer-side commission reconciliation are later slices of issue #4348.

## Enable a provider

1. In **Settings → Security**, configure an instance password. The provider API remains closed when authentication is off, even though ordinary PortOS APIs normally trust the private network in that posture.
2. Register the consumer under **Instances**. The consumer must store this provider's Basic credential on its peer record and send its own registered instance id on every request.
3. Install and verify the desired music runtime and model under **Music**. A model must be locally ready before it can be advertised or accept work.
4. In **Settings → Sharing → Federated media provider**, select the allowed audio models, choose the shared active-job limit, and enable the provider.

The default is disabled:

```json
{
  "federation": {
    "mediaProvider": {
      "enabled": false,
      "maxQueuedJobs": 2,
      "audioModels": []
    }
  }
}
```

An older install without this settings slice behaves exactly like the default above. Known fields are validated while unknown future fields are preserved, so rolling an install back does not erase newer provider settings.

## Authentication and identity

Every request requires both:

- `Authorization: Basic …`, verified against the provider instance password by the global auth gate; browser session and Bearer authentication are deliberately rejected for this peer-only surface.
- `X-PortOS-Instance-Id: <consumer-instance-id>`, resolving to an enabled peer registered on the provider.

Use `peerFetch` for PortOS-to-PortOS calls; it already attaches the configured Basic credential and local instance id. The instance-id header identifies the registered peer, while the Basic credential authenticates access to this PortOS install.

As with existing peer sync, the instance-id header is self-asserted. Basic authentication proves access to the provider install; it does not cryptographically bind that credential to one peer row. Owner-scoped job lookup is therefore a least-disclosure boundary for cooperating peers on the trusted network, not protection from another holder of the same instance password spoofing a registered id.

## Wire v1

All successful JSON responses include `wireVersion: 1`. The version is also fixed in the route path so an incompatible future contract can coexist rather than silently changing v1.

| Method | Endpoint | Purpose |
|--------|----------|---------|
| `GET` | `/api/federation/media/v1/status` | Fresh allowlisted capabilities, CUDA/runtime/model readiness, queue depth, and staleness window |
| `POST` | `/api/federation/media/v1/jobs` | Submit an idempotent audio job; returns `202` for new work and `200` for a replay |
| `GET` | `/api/federation/media/v1/jobs/:id` | Read an owner-scoped sanitized job projection |
| `POST` | `/api/federation/media/v1/jobs/:id/cancel` | Cancel the caller's queued or running job |
| `GET` | `/api/federation/media/v1/jobs/:id/result` | Download completed WAV bytes with integrity metadata |

### Capacity status

`GET /status` is computed live and carries `generatedAt` plus `staleAfterMs`. Consumers must stop assigning new work after that window instead of treating stale capacity as available.

CUDA has three states: `available`, `absent`, and `unknown`. A CUDA model is ready only when the state is positively `available`; a failed or ambiguous probe blocks admission. Runtime, host-platform, exact fixed-checkpoint readiness, and queue capacity are similarly fail-closed.

The configured `maxQueuedJobs` is conservative: all currently queued/running local and remote media work counts against it. This prevents a reachable route from advertising spare capacity while the machine's shared media lane is already occupied.

Status never includes prompts, lyrics, credentials, local paths, commission records, or private creative metadata.

### Submit a job

Send a unique, stable `Idempotency-Key` header with the text-only request:

```json
{
  "engine": "minimax-music3",
  "modelId": "minimax-music3",
  "prompt": "A fictional cinematic synth theme",
  "lyrics": "[instrumental]",
  "durationSec": 60,
  "durationMode": "manual"
}
```

Unknown fields are rejected. The contract accepts no source URL, filesystem path, shell argument, provider credential, or arbitrary proxy target.

Within the queue's retained job window, repeating the same caller/key/body returns the original job without enqueuing again. Reusing that key with a different body returns `409 MEDIA_PROVIDER_IDEMPOTENCY_CONFLICT`. Job lookup and cancellation return the same not-found response for an unknown id and another peer's id.

The provider persists accepted work in the existing machine-local `data/media-jobs.json` queue. No commission, CoS, schedule, taste, or Digital Twin record is copied to the provider. The submitted prompt/lyrics exist only in the provider's local queue record needed to execute that explicit job.

### Download and verify a result

A completed job projection includes `result.sha256`, `result.sizeBytes`, `result.mimeType`, and an owner-scoped `result.downloadUrl`. The download repeats the digest in `X-Content-SHA256`. Consumers should stream to a temporary file, verify both byte count and SHA-256, then atomically promote it into their local library. A missing or changed provider-side file returns a typed unavailable result instead of a dangling path.

Provider filesystem paths and original filenames never cross the API boundary.

## Current boundary

Wire v1 currently provides audio only. Still remaining from #4348 are consumer-side `peerFetch` proxying and restart reconciliation, converting the Music studio's synchronous generation route to the durable queue, capacity-aware peer selection/failover, remote image/video jobs and input-asset transfer, and aggregate provider health in Instances/System Health.
