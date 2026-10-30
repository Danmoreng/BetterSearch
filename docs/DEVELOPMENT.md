# Development

Builds target Windows x64. Install Node.js 26.13.0 or newer, CMake 3.24+ and
Visual Studio 2022 C++ Build Tools, including the Windows SDK.

## Build

From a source checkout:

```powershell
git submodule update --init --recursive
npm ci
npm run setup
npm run build:native
npm run build
npm run typecheck
npm test
```

Setup downloads checksum-pinned native dependencies and the model. Weights go to
the Hugging Face cache; dependencies go to ignored `.runtime/`. llama.cpp is
pinned by the submodule commit. The build downloads the pinned Windows Node.js
LTS runtime independently of the Node version running the build.

The default `windows-cpu` preset uses a static MSVC runtime without CUDA,
machine-specific CPU tuning, required AVX instructions or external OpenMP.
`dist/build-info.json` records the native profile, package version, llama.cpp
commit and bundled Node version.

## Package and verify

```powershell
npm run package
npm run verify:release
```

Packaging accepts only the matching portable CPU build and pinned Node runtime.
It copies an explicit set of runtime outputs and generates a marketplace inside
the ZIP. Upload the ZIP and its SHA-256 file from `artifacts/` as GitHub Release
assets. Generated artifacts do not belong in source control.

Verification extracts the ZIP, registers its actual marketplace, installs it in
an isolated Codex profile and checks the host-resolved transport and desktop tool
catalog. It exercises synthetic search, settings, disconnects and index retention
after restart. It detects the running desktop's bundled Codex executable; if the
app is closed, set `BETTER_SEARCH_CODEX_CLI` to that executable's full path.
See [Release verification](VALIDATION.md) for the remaining manual host checks.

## Local configuration

| Variable | Purpose |
| --- | --- |
| `BETTER_SEARCH_HOME` | Index, preferences and service data; defaults to `%LOCALAPPDATA%\BetterSearch` |
| `BETTER_SEARCH_PORT` | Loopback port; default 39471 |
| `HF_HUB_CACHE` | Shared Hugging Face model cache |
| `HF_HOME` | Hugging Face home; its `hub/` subdirectory is the default cache |
| `BETTER_SEARCH_NO_WATCH=1` | Disable background updates for isolated tests |
| `BETTER_SEARCH_TEST_MODEL` | Explicit verified model file for inference tests |
| `BETTER_SEARCH_QUERY_THREADS` | Query threads, bounded 1–16 |
| `BETTER_SEARCH_EMBED_WORKERS` | Indexing contexts, bounded 1–4; default 1 |
| `BETTER_SEARCH_BATCH_DOCUMENTS` | Passages per batch, bounded 1–128 |
| `BETTER_SEARCH_BATCH_TOKENS` | Batch capacity, bounded 8192–32768 |

The default model cache is `~/.cache/huggingface/hub`; `XDG_CACHE_HOME`
changes the cache base. Index data and model weights have separate lifetimes.

## UI and assets

Use synthetic history in tests and screenshots. `tests/preview-panel.mjs`
provides a development-only panel host. Real desktop navigation still needs
a manual check. English product text lives in `locales/en.json`.

SVGs in `assets/` are editable sources. Listing/composer icons use colored PNGs;
MCP tab icons use constant-RGB masks with alpha transparency. Preserve their
light/dark variants when editing.

## Optional GPU development

`windows-rtx5080` is a hardware-specific development preset requiring the matching
CUDA toolkit and SM 120 hardware:

```powershell
npm run build:native:gpu
$env:BETTER_SEARCH_BUILD_PRESET = 'windows-rtx5080'
npm run build
```

Restore the CPU build before packaging. Other platforms and accelerators need
separate validation.

## Benchmarks

`scripts/benchmark-search.mjs` measures a running test service selected by
`BETTER_SEARCH_HOME` and `BETTER_SEARCH_PORT`. It writes timing and corpus counts
to ignored `artifacts/benchmarks/search.json`. Review reports before sharing.
Measure cold and warm latency separately and evaluate retrieval quality before
changing the model, dimensions or quantization.
