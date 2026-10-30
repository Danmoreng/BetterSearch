# Privacy

BetterSearch stores and processes the configured Codex chat history on your
computer. It imports visible user and assistant messages, creates local text
chunks and embeddings, and stores them in a separate SQLite index. It does not
modify Codex's own databases. The index contains copies of chat text and is not
additionally encrypted; protect it like the original history.

There is no telemetry, cloud database or external embedding API. Setup downloads
native dependencies and model weights from their publishers. Normal search and
indexing do not upload chat content. The local HTTP service binds only to
127.0.0.1, validates Host/Origin and requires a random bearer token for API calls.
The conversation panel uses the host's MCP bridge and has no external resource
or network domains in its content security policy.

When an agent invokes `search_chats`, the returned excerpts become context for
the current conversation and are processed according to that host/model's data
policies. Local embeddings do not imply that the agent runs locally. Direct panel
search does not send a conversation message or request an LLM-generated answer.

BetterSearch does not persist search queries or a search history. Bounded in-memory
caches retain recent query vectors, responses and pagination snapshots while the
service runs. A successful complete source scan removes deleted chats from the
current index; unavailable or incompatible sources are retained with an error.
Index-maintenance backups and SQLite WAL pages may retain older content. To remove all
indexed copies, stop the service and delete the BetterSearch data directory and
backups you chose to retain. This is not secure erasure
of filesystem blocks or separately managed backups.

Model weights are stored separately in the central Hugging Face cache, normally
`~/.cache/huggingface/hub`, respecting `HF_HUB_CACHE` and `HF_HOME`. Removing the
BetterSearch data directory keeps that shared model cache. Remove weights through
your Hugging Face cache-management tools when no other application needs them.

The plugin archive contains software and notices only. It excludes the database,
chat exports, tokens, model weights, service logs and private configuration.

The Settings GUI can disable agent retrieval independently of panel search.
Disabling a source excludes it from results and future indexing but retains its
existing indexed rows. Clear search index empties the active index and pauses
indexing; it keeps model weights and backups. Rebuild and clear create a local
backup first. These controls are not a secure-erasure feature. Diagnostic export
uses an explicit allowlist of counts, version and service state, excluding
excerpts, private paths, source labels, credentials and raw errors.
