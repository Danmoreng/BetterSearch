# Settings

Open **Settings** using the round gear button at the bottom right of the search
panel. All controls work through
the local service; changes save automatically. A failed save is shown inline
and the previous saved value remains active. No configuration-file editing is
required. Settings follow the host app's light/dark appearance.

| Section | Controls and behavior |
| --- | --- |
| Status | Search readiness, searchable-chat count, progress and last source update |
| Search | Include archived chats; Comfortable or Compact result density |
| Data & updates | Automatic updates, Update now, Pause/Resume, and local profiles with editable names and per-source switches |
| Privacy | Disable headless agent retrieval independently of panel search |
| Advanced | Resource profiles, model download/verification, repair, confirmed rebuild/clear and sanitized diagnostic export |

Advanced controls are collapsed initially. The interface uses English and the
host's date formatting; a language selector will return when additional reviewed
translations are available. Returning from Settings preserves the query,
selection, scroll position and completed result snapshot. Archive or source
changes trigger a fresh search so excluded content cannot remain visible.

Automatic updates check for new or changed chats every 15 minutes. An automatic
scan waits for any active semantic indexing to finish. Unchanged text retains
its existing search vectors. Turning automatic updates off lets an
active job finish. Pause stops work at the next import step or embedding batch
boundary; it does not stop search. Resume explicitly starts an update even when
automatic updates are off. Resource profiles change background batch sizes and
breaks, preserving the search algorithm and model fingerprint.

**Checking chats for changes** reads enabled sources and imports changed chats.
**Updating search by meaning** computes missing vectors locally; it is not a
user search. A backlog can keep this second step running beyond the update
interval. Update index now completes both steps even with automatic updates off.
Disabled sources do not create background vector jobs. A failed semantic update
waits for an explicit update, repair or successful model setup before retrying.

Sources are validated with the same read-only importer used for indexing.
Turning a source off excludes it from search, project filters and future
indexing while retaining its existing rows and vectors. Source names and new
sources can be changed after active indexing finishes. No SSH connection or
filesystem-wide indexing is offered.

Model installation checks the pinned model in the shared Hugging Face cache before downloading. A
download contacts Hugging Face for model weights, never chat content. Downloads
activate only after the pinned SHA-256 passes. The service owns the installation
job, so disconnecting a panel or agent does not cancel it. If the service stops
during installation, retry from Settings. Weights use the central cache, normally
`~/.cache/huggingface/hub`, respecting `HF_HUB_CACHE` and `HF_HOME`. No model copy
is kept in the index folder.

Repair scans enabled sources and fills missing embeddings. Rebuild first backs
up the index, then recreates it from enabled sources. Clear first backs up the
index, empties the active index and pauses indexing. Both preserve original
Codex history and downloaded models; existing backups remain. They are not
secure-erasure operations. Confirmation dialogs describe these effects.

Diagnostics display version, index storage and local CPU inference. Export opens
a Windows Save dialog and writes a JSON report containing counts and service
state. It excludes chat text, queries, tokens, source labels, private paths and
raw errors. Advanced maintenance controls wait for active indexing or model
installation to finish.
