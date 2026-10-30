# Release verification

Run these checks on both Windows x64 and Linux x64 after building the platform
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

The release verifier extracts the platform archive, registers its included marketplace in an
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
- Confirm the archive and source changes contain no private data or model weights.

Automated protocol checks do not establish visual host behavior or compatibility
with every host version. The optional GPU development profile and additional architectures require
their own validation.

For Linux, also check the native GTK folder and save pickers under the target
desktop session, cancellation, overwritten-file confirmation and model setup
from Settings. `better-search-dialog --self-test` checks GTK initialization
without opening a window. The service-side tests use synthetic helper processes
to cover paths containing spaces/quotes, cancellation, failed model setup and
child-process cleanup. A local Arch package does not establish compatibility
with the older glibc/libstdc++ baseline used by the Linux CI release build.

For a local CUDA build, run `BETTER_SEARCH_TEST_REQUIRE_GPU=1 npm test` with
verified weights and a working NVIDIA driver. The model tests require GPU use
for the first build and full rebuild, CPU use for incremental updates, and a
separate CPU query context. `npm run stage:local` creates a development-only
marketplace; public `npm run package` must continue rejecting CUDA binaries.
