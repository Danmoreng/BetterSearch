# BetterSearch product specification

BetterSearch provides fast, private search across local Codex chats. Its primary
interface is a search panel beside a conversation. A separate headless tool lets
an agent search the same index without opening the panel.

## Scope

- Import visible user and assistant messages from configured local Codex sources.
- Search original passages with local embeddings and keyword retrieval, fused
  into one final ranking per query.
- Show a title, original excerpt, project, date and verified original-chat link.
- Offer project and updated-date filters below the search field and quoted
  exact phrases in the normal query,
  with focused GUI settings for local search, sources and index health.
- Run one shared local HTTP service behind local stdio MCP adapters.
- Ship an English interface and English engineering documentation. Interface
  strings are externalized for future reviewed translations.
- Distribute source and Windows x64 manual-install packages through GitHub.

The product does not include project maps, relationships, logical project
grouping, a global/fullscreen application, a standalone browser product, a chat
reader, filesystem-wide search, OCR, media ingestion, SSH collection or replication.

## Interaction contract

1. Opening the panel, empty input and whitespace show no results and issue no
   search request. The service also returns no results for empty queries.
2. A nonempty query starts one hybrid request after 180 ms of input inactivity.
   This is debounce time, not an end-to-end latency promise.
3. No provisional keyword results are rendered. One completed response replaces
   the list. If semantic retrieval is unavailable, a clearly labeled final
   keyword-only response is permitted, with no later enrichment.
4. Editing, clearing, closing or changing a filter invalidates earlier requests.
   Results from an earlier revision must never become visible.
5. Pagination uses one immutable ranked snapshot, bounded to the top 100 chats.
   Background indexing cannot reorder that snapshot. Expired snapshots require
   a new search rather than silently reranking.
6. Pointer and keyboard selection leave rows attached. Enter and click open the
   same validated original-chat link. Escape clears the term and preserves filters.
7. Indexing and query inference use independent resources. Search never waits
   for a complete background embedding job.
8. Headless agent search does not request a UI resource or invoke the panel tool.
9. The empty start contains no explanatory onboarding text or recent chats.
   Project and date dropdowns sit below the search; empty results offer explicit recovery
   actions without silently removing constraints.
10. Visiting Settings preserves completed results, selection and scroll position.
    Result-affecting settings changes require a fresh search when returning.

The host owns the panel's lifetime: a thread entrypoint has a separate instance
per chat. Opening an original chat can switch away from the search panel. The
documented link API does not provide a keep-panel or new-window target; a global
fullscreen entrypoint does not guarantee search and chat remain visible together.

## Release acceptance

- Source data stays read-only. A fresh profile creates the current index;
  unsupported index schemas are rejected without conversion.
- Failed or unsupported source scans retain previously indexed content. A
  complete successful scan removes deleted chats from the separate search index.
- The Windows CPU build does not require CUDA or machine-specific AVX settings.
- A manual-install release includes its Node runtime, native service, UI, notices
  and setup commands; no compiler or npm dependency installation is needed.
- Model download is explicit, atomic, checksum-verified and reports progress.
  Weights use the central Hugging Face cache and a pinned revision.
- Search, source, background, model and access settings are operable through
  the GUI with saved feedback and inline errors; no configuration editing is required.
- Turning off agent search preserves the human panel. Disabled sources are
  excluded from search and filters without deleting compatible indexed vectors.
- Destructive index maintenance requires confirmation and creates a backup.
- A fresh-profile installation and restart preserve the index. Cache downloads,
  request cancellation, navigation and agent protocol behavior have regression tests.
- Public marketplace submission and GitHub publishing are separate actions.
