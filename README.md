# BetterSearch

Search your local Codex chats by keyword or meaning. Open a search panel beside
your conversation, or let an agent retrieve passages from earlier chats.
Indexing and embeddings run on your computer. Automatic Codex Guardian review
threads are excluded using their origin metadata; ordinary chats are retained.

## Install

Requires a Windows x64 or Linux x64 desktop and a ChatGPT/Codex desktop
installation that supports local plugins. Each platform has its own package,
including Node.js 26.13.0 and the CPU search service. No compiler, CUDA or
`npm install` is needed to use a release. ARM64 is not currently packaged.

Download the package and its `.sha256` file from
[Releases](https://github.com/Danmoreng/BetterSearch/releases/latest), when available.
Use a release asset rather than GitHub's **Source code** ZIP.

### Windows

1. Download `better-search-<version>-windows-x64.zip`.
2. Compare `Get-FileHash .\better-search-<version>-windows-x64.zip -Algorithm SHA256`
   with the checksum, then extract the ZIP into a folder you will keep.
3. Open PowerShell in that folder and register the included marketplace:

   ```powershell
   codex plugin marketplace add .
   ```

### Linux

Linux needs glibc, libstdc++ and GTK 3.24 or newer. The native GTK file picker
integrates with XFCE/X11 and uses the desktop portal when configured. No Zenity
or KDialog command is required. On Arch Linux, GTK is provided by `gtk3`;
Ubuntu/Debian use `libgtk-3-0` (or the distribution's replacement package).

1. Download `better-search-<version>-linux-x64.tar.gz` and its checksum.
2. Verify and extract into a folder you will keep:

   ```sh
   sha256sum -c better-search-<version>-linux-x64.tar.gz.sha256
   mkdir better-search
   tar -xzf better-search-<version>-linux-x64.tar.gz -C better-search
   cd better-search
   codex plugin marketplace add .
   ```

Official Linux packages are intended to be built on the Ubuntu 22.04 baseline.
A package built locally on a newer distribution can require newer system
libraries; build from source on the target distribution when necessary.

On either platform, restart the app, open the Plugins Directory, select
**BetterSearch local**, and install **BetterSearch**. Local plugin availability
depends on your host and workspace policy. The `codex` command must belong to
your desktop installation; see [troubleshooting](#troubleshooting) if unavailable.

## Use

1. Start a new local chat with BetterSearch enabled. Open
   **New Tab → More Tools… → BetterSearch**. Menu labels may vary by host version.
2. Open the gear button, then **Advanced → Search model → Download model** to
   enable search by meaning. The model download is about 558 MB and is verified
   before use. Weights go to the shared Hugging Face cache, normally
   `~/.cache/huggingface/hub`, respecting `HF_HUB_CACHE` and `HF_HOME`.
   Keyword search works without it.
3. Type a query. Filter by project or updated date, or use quotation marks for
   exact phrases. Click a result or press Enter to open the original chat.
   Arrow keys select a result; Escape clears the query.

The service imports chats in the background and checks for changes every
15 minutes. Initial indexing can take time. Settings shows progress and lets
you update now, pause indexing, select sources, and control agent access.
See [Settings](docs/SETTINGS.md) for maintenance options.

To search through an agent, ask something like:

> Find my earlier Codex discussion about OAuth sign-in using BetterSearch.

The agent uses `search_chats` without opening a panel. `search_status` reports
index coverage. `open_search` opens the panel when explicitly requested.

## Privacy

Chats and embeddings stay in a separate local index. BetterSearch does not modify
Codex's databases, upload chats for indexing, or collect telemetry. Model setup
downloads weights from Hugging Face. Passages retrieved by an agent become part
of that agent's conversation context. See [Privacy](PRIVACY.md).

Data is stored in `%LOCALAPPDATA%\BetterSearch` on Windows and
`${XDG_DATA_HOME:-~/.local/share}/BetterSearch` on Linux. The service starts on demand
and can keep indexing after you close the panel. In the extracted folder,
`status.cmd` checks it and `stop.cmd` stops it on Windows; Linux uses
`./status.sh` and `./stop.sh`. Data and models remain on disk.

## Troubleshooting

- **`codex` is not found:** use the `codex` executable bundled with your desktop
  installation, or make that executable available on PATH. Local marketplace
  registration is described in the [official plugin documentation](https://developers.openai.com/plugins/build/plugins#add-a-marketplace-from-the-cli).
- **The panel is missing:** check that the plugin is installed and enabled, then
  start a new chat. `codex mcp list --json` should show `better-search` enabled.
- **No results yet:** check indexing progress and enabled sources in Settings,
  then choose **Update now**. Codex's internal history format can change;
  unsupported sources are reported in Settings.
- **Search by meaning is unavailable:** download or verify the model in Settings.
  Keyword search remains available.
- **Updating:** stop the running service with `stop.cmd` (Windows) or `./stop.sh`
  (Linux), extract the new release,
  register its marketplace folder, and reinstall the plugin from that source.
  Your index and preferences are stored separately from the plugin.

## Development

See [Development](docs/DEVELOPMENT.md) for building and verifying a release,
[Architecture](docs/ARCHITECTURE.md) for the implementation, and
[Contributing](CONTRIBUTING.md) for contribution guidelines. Windows x64 and Linux x64 use separate CPU packages from the same codebase.
Source checkouts need a build and package before installation. Optional local
[CUDA builds](docs/DEVELOPMENT.md#optional-cuda-indexing) accelerate embedding
generation while keeping queries on the CPU; public packages remain CPU-only.

MIT licensed. See [License](LICENSE) and [Third-party notices](THIRD_PARTY_NOTICES.md).
