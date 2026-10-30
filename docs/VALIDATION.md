# Release verification

Run these checks from a Windows x64 source checkout after building the portable
CPU service and UI:

```powershell
npm run typecheck
npm test
npm run package
npm run verify:release
```

Tests use synthetic chat databases. Model-dependent cases require verified local
weights; review skipped tests before claiming semantic-search coverage. See
[Development](DEVELOPMENT.md) for setup and model selection.

The release verifier extracts the ZIP, registers its included marketplace in an
isolated Codex profile, installs the plugin and uses the host-resolved MCP
transport. It checks the bundled runtime, desktop tool catalog, panel resource,
empty queries, source import, phrase/date filters, headless retrieval, settings,
adapter disconnects and restart with an unchanged index.

Use the desktop-bundled Codex executable. If it cannot be detected automatically,
set `BETTER_SEARCH_CODEX_CLI` to its full path. The check does not replace the
active plugin installation or use personal chats as fixtures.

Before publishing a GitHub release, also check in the desktop UI:

- Install from the extracted marketplace and open BetterSearch in a new chat.
- Verify light/dark appearance, keyboard selection and opening an original chat.
- Download or verify the model and wait for initial indexing to complete.
- Restart the host and confirm search still works.
- Confirm the ZIP and source changes contain no private data or model weights.

Automated protocol checks do not establish visual host behavior or compatibility
with every host version. Other platforms and the optional GPU development
profile require their own validation.
