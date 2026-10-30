# Development

Builds target Windows x64 and Linux x64 from one codebase. Install Node.js
26.13.0 or newer and CMake 3.25+ (preset schema 6).
Windows uses Visual Studio 2022 C++ Build Tools and the Windows SDK.
Linux uses a C++20 compiler, Ninja, pkg-config and GTK 3 development headers:

```sh
# Arch Linux
sudo pacman -S --needed base-devel cmake ninja pkgconf gtk3
# Ubuntu / Debian
sudo apt install build-essential cmake ninja-build pkg-config libgtk-3-dev
```

Run Linux release builds on the Ubuntu 22.04 baseline, as configured in
`.github/workflows/validate.yml`. The native service dynamically links glibc and
libstdc++; the dialog helper dynamically links the system GTK. Builds on newer
distributions inherit their system library requirements. ARM64 and musl systems
are not release targets.

On older distributions, install CMake 3.25 or newer separately when the system
package is older.

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

Setup downloads checksum-pinned native dependencies into ignored `.runtime/`.
Add `-- --model` to setup to also download the verified model into the Hugging
Face cache, or download it later from Settings. llama.cpp is
pinned by the submodule commit. The build downloads the pinned platform-specific Node.js
runtime independently of the Node version running the build.

On Windows the default `windows-cpu` preset uses a static MSVC runtime without CUDA,
machine-specific CPU tuning, required AVX instructions or external OpenMP.
Linux defaults to `linux-cpu`, also without CUDA, required AVX or external
OpenMP. The Windows GPU development profile remains explicitly opt-in.
`dist/build-info.json` records the target platform, native profile, package
version, llama.cpp commit and bundled Node version. The source MCP manifests
retain the Windows development configuration; packaging generates both MCP
manifests for the actual target. Install the generated package on Linux.

## Package and verify

```powershell
npm run package
npm run verify:release
```

Packaging accepts only the matching portable CPU build and pinned Node runtime.
It copies an explicit set of runtime outputs and generates a marketplace inside
the Windows ZIP or Linux tar.gz. Linux archives preserve executable permissions.
Upload the platform archive and its SHA-256 file from `artifacts/` as GitHub
Release assets. Generated artifacts do not belong in source control. Each build also
writes `artifacts/release-<target>.json` and an isolated marketplace under
`artifacts/marketplace/<target>/`, so the two targets do not overwrite each other.

Verification extracts the platform archive, registers its actual marketplace, installs it in
an isolated Codex profile and checks the host-resolved transport and desktop tool
catalog. It exercises synthetic search, settings, disconnects and index retention
after restart. It detects the running desktop's bundled Codex executable; on
Linux it also checks the standard desktop install path. If detection fails, set
`BETTER_SEARCH_CODEX_CLI` to that executable's full path.
See [Release verification](VALIDATION.md) for the remaining manual host checks.

## Local configuration

| Variable | Purpose |
| --- | --- |
| `BETTER_SEARCH_HOME` | Index, preferences and service data; defaults to `%LOCALAPPDATA%\BetterSearch` on Windows or `${XDG_DATA_HOME:-~/.local/share}/BetterSearch` on Linux |
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

## Optional CUDA indexing

The public Windows/Linux packages remain CPU-only. Self-builds can offload
embedding generation to NVIDIA CUDA on either platform; semantic query inference
always uses a separate CPU model. The GPU model is released when a background
embedding job completes or is paused. CUDA is eligible only for the first full
embedding build or an explicit full rebuild. Later incremental embeddings use
the CPU. Completion is persisted in the search index; pausing an unfinished
first build does not mark it complete. Existing compatible embeddings survive switching
between CPU and CUDA builds; no rebuild of the search index is required.

Install a compatible NVIDIA driver and CUDA toolkit, then build for the local GPU:

```sh
npm run build:native:cuda
npm run build:cuda
npm run stage:local
```

The last command creates a development-only marketplace under
`artifacts/local/linux-cuda` or `artifacts/local/windows-cuda`. Register that
folder using the desktop-bundled CLI, then install BetterSearch from it in a new
chat. Stop the old service before changing builds. This marketplace requires the
matching CUDA toolkit/runtime libraries on the same machine and is not a portable
release. It does not replace `artifacts/marketplace/<target>` or the release archive.
`npm run package` rejects CUDA builds.

The generic `linux-cuda` and `windows-cuda` presets default to
`CMAKE_CUDA_ARCHITECTURES=native`. To specify an architecture explicitly, set
`BETTER_SEARCH_CUDA_ARCHITECTURES`, for example `120-real` for the local RTX 5080.
Use a semicolon-separated CMake list to target multiple architectures. CUDA and
its host compiler must be compatible. On Arch, if the default GCC is newer than
CUDA supports, select an installed supported compiler, for example:

```sh
CUDAHOSTCXX=/usr/bin/g++-15 npm run build:native:cuda
```

`BETTER_SEARCH_DEVICE=cpu` forces CPU embeddings even in a CUDA build. If device
initialization, allocation or inference fails, background embeddings fall back to
CPU. Query inference remains CPU-only in every mode. Settings reports GPU
indexing while it is active. CUDA accelerates embedding inference, not the
SQLite import or file scanning portion of initial indexing.

For hardware validation, run with verified model weights:

```sh
BETTER_SEARCH_TEST_REQUIRE_GPU=1 npm test
```

This requires actual GPU offload rather than accepting the normal CPU fallback,
and compares CPU-query embeddings with document inference. It is separate from
the CPU-only CI matrix. Vulkan builds are not part of this change.

The existing hardware-specific `windows-rtx5080` preset and
`npm run build:native:gpu` remain available for the original Windows development
setup; they require the configured CUDA 13.3 path and SM 120 hardware. Use
`BETTER_SEARCH_BUILD_PRESET=windows-rtx5080` with `npm run build` for that profile.
The new generic CUDA presets do not hardcode a toolkit path or AVX512 CPU tuning.

Restore the portable build before creating a public package:

```sh
npm run build:native
npm run build
npm run package
```

## Benchmarks

`scripts/benchmark-search.mjs` measures a running test service selected by
`BETTER_SEARCH_HOME` and `BETTER_SEARCH_PORT`. It writes timing and corpus counts
to ignored `artifacts/benchmarks/search.json`. Review reports before sharing.
Measure cold and warm latency separately and evaluate retrieval quality before
changing the model, dimensions or quantization.

## Platform regression checks

The CI matrix builds and tests Windows 2022/MSVC and Ubuntu 22.04/GCC, including
real model inference, before creating separate packages. Desktop installation
and catalog checks remain `npm run verify:release` checks on each target host.
On Linux, verify the native dialog helper in a desktop session with
`dist/native/better-search-dialog --self-test`; it initializes GTK without
showing a picker. Manually test folder/save selection, cancellation and chat
navigation in the desktop app before publishing.

## GitHub releases

Push a version tag matching `package.json`, for example `v0.8.0`, after committing
the release changes. The workflow builds Windows and Linux CPU packages, runs
model tests and verifies each extracted archive with the pinned official Codex
protocol host. CI has no desktop UI; local desktop verification remains separate.
Only after both matrix jobs pass does the publish job create the GitHub Release
with both archives and their SHA-256 files. CUDA development outputs are excluded.
