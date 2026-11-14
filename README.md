# OpenClaw Personal

Personal communication hub for OpenClaw. Package/plugin ID: `openclaw-personal`. Display name: **Personal**.

## Current features

Adds an isolated navigation entry with official Gmail, Outlook, Zalo Web and Messenger launchers. Links open externally; each service owns its login.

**Launcher only, not a unified inbox.** No message synchronization, unread counts, notifications, credential storage, website embedding, or automatic sending. No configured account messages are read. LinkedIn and in-app connectors are future work.

## Develop

Requires Node.js and OpenClaw 2026.11.3 or a compatible version.

```sh
npm install
npm run build
npm test
openclaw plugins build --root .
npm run validate
```

- `src/control-ui.js`: page and navigation; page ID `inbox`.
- `src/control-ui.css`: namespaced styles.
- `src/index.js`: feature SDK backend, with no operations, events or tools.
- `test/inbox.test.mjs`: official URL, DOM, accessibility and registration checks.

Build copies browser source to precompiled ESM assets declared in the manifest. The host constructs the page route.

## Package

```sh
openclaw plugins pack --root . --out openclaw-personal-0.1.0.tgz --json
```

Install the archive through the supported OpenClaw plugin workflow. Enable **Settings > Labs > Custom plugin UI** to load the native page. Native plugin JavaScript runs with operator UI authority; review source first. This is not an official OpenClaw plugin.

Editing this source does not change an installed copy. Build, validate, package and explicitly update the plugin. This renamed package has not replaced the original local installation.

## Future integrations

Email read/reply requires a chosen provider and official authorization. Unofficial personal Zalo automation requires explicit risk acceptance. Personal Messenger support needs independent verification; Facebook Page/Instagram APIs are not personal Messenger. No working account connector is claimed.
