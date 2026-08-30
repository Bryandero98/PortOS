# Eidoverse Worlds integration

Eidoverse Worlds is an optional, disabled-by-default PortOS feature. It is not
vendored into PortOS and is not a git submodule. Choosing **Install & enable**
under **Settings → Features** is the explicit consent boundary that downloads,
installs, and enables the runtime; the ordinary feature toggle never installs it.
If Bun is not already available, the same action first runs Bun's official
platform installer under the PortOS service account on Windows, macOS, or Linux.

## What PortOS installs

The installer keeps the two AGPL-3.0 projects as independent git checkouts. The
Worlds repository is selected per PortOS instance; the canonical upstream is
the default, while an instance owner can enter their own fork before installing:

- `data/repos/{owner}/{repo}` — the selected Worlds repository and the checkout
  PortOS registers under **Apps**. Ordinary GitHub forks retain the
  `eidoverse-worlds` repository name.
- `data/repos/anima-research/eidoverse-video` — the upstream video/runtime
  checkout used by Worlds. A fork is not required unless changes to that
  repository itself become necessary.

PortOS runs `bun install --frozen-lockfile` in the Worlds root and client, then
writes an ignored `.env.portos` file that points Worlds at the video runtime and
at its durable world store. PortOS does not copy either project's source into
the PortOS repository, combine the codebases, or relicense them; each checkout
retains its own upstream license and git history.

After installation, the **Worlds GitHub repository** field remains available on
**Settings → Features**. Updating it changes the installed checkout's `origin`
in place, so the managed-app path, local working tree, and world data stay
untouched. The companion video checkout remains on its upstream repository.

## Runtime and data ownership

The managed app uses port `8940` and starts with the Bun executable found or
installed during setup:

```text
<bun> --env-file=.env.portos server/server.ts
```

Installation does not start the server. Start, stop, logs, updates, and launch
links remain visible on the normal managed-app screen. Plain-HTTP managed apps
keep an `http://` launch URL even when PortOS itself is open over HTTPS, so the
Apps launch action works from a Tailscale MagicDNS session. Managed updates pull
both the selected Worlds checkout and its companion video runtime before using
Bun's frozen lockfile rather than npm.

When the feature is enabled, **Eidoverse** appears beside OpenWorld in PortOS's
primary navigation. Opening it starts the managed app when needed and embeds its
web client in a full-width PortOS page. OpenWorld remains available during this
evaluation; replacing or redirecting it is a separate product decision after
the Eidoverse integration proves the required behavior.

Durable Eidoverse world logs live at `data/eidoverse/worlds`. This is
machine-local `file-primary` data: PortOS backups include it, but PortOS does
not federate it to peers. The git checkouts remain under `data/repos`, which is
the existing re-cloneable repository backup class.

Disabling the feature does not delete repositories, unregister the app, stop a
running process, or remove world history. It only records that this PortOS
instance is not actively using the integration. Destructive uninstall remains
an explicit manual operation.

## Network boundary

This integration is intended for the same private, single-user Tailscale trust
boundary as PortOS. Eidoverse binds its server to the host network and permits
an empty join token; do not expose this configuration to the public internet.
An instance that needs a broader trust model should configure Eidoverse access
control in that project before starting it.

Eidoverse itself remains a plain-HTTP service on `:8940`. For an HTTPS PortOS
session, the embedded page lazily opens a PortOS-owned HTTPS/WebSocket bridge on
`:5563`, using the same machine certificate as `:5555` and forwarding to
`127.0.0.1:8940`. This avoids browser mixed-content rejection while leaving both
external repositories unchanged. The bridge starts only when the page is
opened, waits for the managed app to answer before mounting the iframe, and
returns an explicit unavailable state when the runtime does not become ready.

## PortOS bridge boundary

The hosted UI and runtime management do not yet bridge Persistent Mind presence,
agent identity, or dynamic PortOS buildings/assets. Those should be implemented
as explicit adapters across the two projects' public protocols. They must remain
opt-in and must not cause provider calls at PortOS boot.
