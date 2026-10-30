# BetterSearch

Search your local Codex chats by keyword or meaning. Open a search panel beside
your conversation, or let an agent retrieve passages from earlier chats.
Indexing and embeddings run on your computer.

## Install

Requires Windows x64 and a Codex desktop installation that supports local plugins.
The release includes Node.js 26 LTS and the CPU search service with llama.cpp
linked in. No compiler, CUDA or `npm install` is needed.

1. Download the Windows x64 ZIP and its `.sha256` file from
   [Releases](https://github.com/Danmoreng/BetterSearch/releases/latest).
   Use the release asset, not GitHub's **Source code** ZIP.
2. Compare `Get-FileHash .\better-search-<version>-windows-x64.zip -Algorithm SHA256`
   with the checksum, then extract the ZIP into a folder you will keep.
3. Open PowerShell in that extracted folder and register the included marketplace:

   ```powershell
   codex plugin marketplace add .
   ```

4. Restart Codex, open the Plugins Directory, select **BetterSearch local**, and
   install **BetterSearch**. Local plugin availability depends on your host and
   workspace policy. The `codex` command must belong to your desktop installation;
   see [installation troubleshooting](#troubleshooting) if it is unavailable.

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

Data is stored in `%LOCALAPPDATA%\BetterSearch`. The service starts on demand
and can keep indexing after you close the panel. In the extracted folder,
`status.cmd` checks it and `stop.cmd` stops it. Data and models remain on disk.

## Troubleshooting

- **`codex` is not found:** use the `codex.exe` bundled with your desktop
  installation, or make that executable available on PATH. Local marketplace
  registration is described in the [official plugin documentation](https://developers.openai.com/plugins/build/plugins#add-a-marketplace-from-the-cli).
- **The panel is missing:** check that the plugin is installed and enabled, then
  start a new chat. `codex mcp list --json` should show `better-search` enabled.
- **No results yet:** check indexing progress and enabled sources in Settings,
  then choose **Update now**. Codex's internal history format can change;
  unsupported sources are reported in Settings.
- **Search by meaning is unavailable:** download or verify the model in Settings.
  Keyword search remains available.
- **Updating:** stop the running service with `stop.cmd`, extract the new release,
  register its marketplace folder, and reinstall the plugin from that source.
  Your index and preferences are stored separately from the plugin.

## Development

See [Development](docs/DEVELOPMENT.md) for building and verifying a release,
[Architecture](docs/ARCHITECTURE.md) for the implementation, and
[Contributing](CONTRIBUTING.md) for contribution guidelines. Only Windows x64 CPU
releases are supported. Source checkouts need a build before installation.

MIT licensed. See [License](LICENSE) and [Third-party notices](THIRD_PARTY_NOTICES.md).
