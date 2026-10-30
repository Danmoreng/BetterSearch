#include "search.hpp"
#include <algorithm>
#include <cmath>
#include <regex>
#include <set>
#include <sstream>

namespace bettersearch {
static std::string key(const std::string &source, const std::string &id) {
    return source + ":" + id;
}

json Engine::status() {
    std::lock_guard lock(mutex);
    Db db(db_path());
    auto counts = db.query("SELECT (SELECT count(*) FROM threads) threads,(SELECT count(*) FROM "
                           "projects) projects,(SELECT count(*) FROM chunks) chunks,(SELECT "
                           "count(*) FROM chunks WHERE embedded=1) embedded,(SELECT count(*) FROM "
                           "threads WHERE content_available=0) metadata_only")[0];
    counts["sources"] = db.query("SELECT id,label,kind,last_sync,warnings FROM sources");
    counts["model"] = config["model"];
    counts["model_ready"] = fs::is_regular_file(fs::u8path(str(config, "model_file")));
    counts["dimensions"] = 768;
    counts["version"] = BETTER_SEARCH_VERSION;
    counts["query_backend"] = "cpu-only";
    counts["vector_rows"] = db.query("SELECT count(*) n FROM chunk_vectors")[0]["n"];
    counts["database"] = utf8(db_path());
    counts["database_bytes"] = fs::file_size(db_path());
    counts["indexing"] = indexing.load();
    counts["embedding"] = embedding.load();
    counts["progress"] = progress;
    if (!indexing && !embedding && !embedding_error.empty()) {
        auto active = db.query("SELECT count(*) total,COALESCE(sum(c.embedded),0) done FROM chunks c "
                               "JOIN threads t ON t.key=c.thread_key WHERE t.source_id NOT IN "
                               "(SELECT value FROM json_each(?))", {preferences["disabled_sources"].dump()})[0];
        counts["progress"] = {{"phase", "embedding_error"}, {"done", active["done"]},
                              {"total", active["total"]}, {"error", embedding_error}};
    }
    {
        std::lock_guard profile_lock(performance_mutex);
        counts["performance"] = performance;
    }
    return counts;
}
json Engine::tree() {
    std::lock_guard lock(mutex);
    Db db(db_path());
    auto disabled = preferences["disabled_sources"].dump();
    return {{"sources", db.query("SELECT id,label,kind,last_sync FROM sources WHERE id NOT IN (SELECT value FROM json_each(?)) ORDER BY label", {disabled})},
            {"projects",
             db.query("SELECT p.*,count(t.key) thread_count FROM projects p LEFT JOIN threads t ON "
                      "t.project_key=p.key WHERE p.source_id NOT IN (SELECT value FROM json_each(?)) GROUP BY p.key ORDER BY p.name COLLATE NOCASE", {disabled})},
            {"repositories", db.query("SELECT source_id,repo,count(*) thread_count FROM threads "
                                      "WHERE repo<>'' AND source_id NOT IN (SELECT value FROM json_each(?)) GROUP BY source_id,repo ORDER BY repo", {disabled})}};
}
json Engine::start_index(bool automatic) {
    std::lock_guard lock(mutex);
    if (stopping || paused) return {{"started", false}, {"reason", "paused"}};
    if (indexing || embedding || model_installing) {
        if (!automatic) index_pending = true;
        return {{"started", false}, {"reason", "already_running"}};
    }
    index_pending = false;
    indexing = true;
    if (!automatic) embedding_error.clear();
    update_schedule.defer();
    if (index_thread.joinable())
        index_thread.join();
    index_thread = std::thread([this] {
        try {
            index();
            if (!stopping && !paused) embedding_pending = true;
        } catch (const std::exception &e) {
            std::lock_guard lock(mutex);
            progress["error"] = e.what();
        }
        std::lock_guard lock(mutex);
        update_schedule.defer();
        indexing = false;
    });
    return {{"started", true}};
}
json Engine::start_embeddings(bool retry) {
    std::lock_guard lock(mutex);
    if (stopping || paused || model_installing) return {{"started", false}, {"reason", "paused"}};
    if (indexing || embedding)
        return {{"started", false}, {"reason", "already_running"}};
    if (!retry && !embedding_error.empty()) return {{"started", false}, {"reason", "needs_retry"}};
    if (retry) embedding_error.clear();
    Db db(db_path());
    if (db.query("SELECT EXISTS(SELECT 1 FROM chunks c JOIN threads t ON t.key=c.thread_key "
                 "WHERE c.embedded=0 AND t.source_id NOT IN (SELECT value FROM json_each(?))) pending",
                 {preferences["disabled_sources"].dump()})[0]["pending"] == 0)
        return {{"started", false}, {"reason", "no_work"}};
    if (!fs::is_regular_file(fs::u8path(str(config, "model_file"))))
        return {{"started", false}, {"reason", "model_missing"}};
    embedding_error.clear();
    embedding_pending = false;
    embedding = true;
    if (embed_thread.joinable())
        embed_thread.join();
    embed_thread = std::thread([this] {
        try {
            embed();
        } catch (const std::exception &e) {
            std::lock_guard lock(mutex);
            progress["error"] = e.what();
            progress["phase"] = "embedding_error";
            embedding_error = e.what();
        }
        { std::lock_guard lock(inference_mutex); index_inference.reset(); }
        embedding = false;
    });
    return {{"started", true}};
}
void Engine::background_tick() {
    std::lock_guard lock(mutex);
    bool busy = stopping || paused || model_installing || indexing || embedding;
    if (busy) return;
    if (index_pending) { start_index(); return; }
    if (embedding_pending.exchange(false)) {
        try { start_embeddings(false); }
        catch (const std::exception &error) { embedding_error = error.what(); }
        if (embedding) return;
    }
    if (update_schedule.due(UpdateSchedule::Clock::now(), automatic_updates, false))
        start_index(true);
}
void Engine::index() {
    json sources;
    {std::lock_guard lock(mutex); sources = config["sources"];}
    for (const auto &source : sources) {
        if (stopping || paused)
            return;
        {std::lock_guard lock(mutex); auto &disabled = preferences["disabled_sources"];
         if (std::find(disabled.begin(), disabled.end(), source["id"]) != disabled.end()) continue;}
        auto sid = str(source, "id");
        SourceData data;
        try {
            data = scan_source(source);
        } catch (const std::exception &e) {
            std::lock_guard lock(mutex);
            Db db(db_path());
            db.run("UPDATE sources SET warnings=? WHERE id=?",
                   {json::array({e.what()}).dump(), sid});
            continue;
        }
        std::unique_ptr<Db> history;
        if (!data.history.empty())
            history = std::make_unique<Db>(data.history, true);
        int done = 0;
        {
            std::lock_guard lock(mutex);
            progress = {{"phase", "import"},
                        {"done", 0},
                        {"total", data.threads.size()},
                        {"error", nullptr}};
        }
        for (const auto &[tid, meta] : data.threads) {
            if (stopping || paused)
                return;
            auto tk = key(sid, tid);
            auto title = str(meta, "title", "Untitled chat"), cwd = str(meta, "cwd"),
                 repo = str(meta, "_repository", normalize_origin(str(meta, "git_origin_url"))),
                 branch = str(meta, "git_branch"), pid = str(meta, "project_id");
            auto pk = key(sid, pid.empty() ? (cwd.empty() ? "unassigned" : cwd) : pid);
            std::string pn =
                pid.empty()
                    ? (cwd.empty() ? "No project" : utf8(fs::u8path(cwd).filename()))
                    : (data.projects.contains(pid) ? str(data.projects[pid], "name", pid) : pid);
            auto rollout = fs::u8path(str(meta, "_rollout", str(meta, "rollout_path")));
            auto stamp =
                fs::is_regular_file(rollout)
                    ? std::to_string(fs::file_size(rollout)) + ":" +
                          std::to_string(fs::last_write_time(rollout).time_since_epoch().count())
                    : "";
            auto signature =
                hash(json::array({title, cwd, repo, branch, str(meta, "archived"),
                                  str(meta, "updated_at"), str(meta, "_history_signature"), stamp})
                         .dump());
            bool unchanged = false;
            {
                std::lock_guard lock(mutex);
                Db db(db_path());
                db.exec("BEGIN IMMEDIATE");
                try {
                    db.run("INSERT INTO projects(key,source_id,name,path,repo) VALUES(?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET name=excluded.name,path=excluded.path,repo=excluded.repo WHERE projects.name IS NOT excluded.name OR projects.path IS NOT excluded.path OR projects.repo IS NOT excluded.repo", {pk,sid,pn,cwd,repo});
                    if (sqlite3_changes(db.handle)) db.exec("UPDATE settings SET value=CAST(value AS INTEGER)+1 WHERE key='corpus_revision'");
                    db.run("UPDATE threads SET project_key=? WHERE key=? AND project_key IS NOT ?", {pk,tk,pk});
                    if (sqlite3_changes(db.handle)) db.exec("UPDATE settings SET value=CAST(value AS INTEGER)+1 WHERE key='corpus_revision'");
                    db.exec("COMMIT");
                } catch (...) { db.exec("ROLLBACK"); throw; }
                auto old = db.query("SELECT signature FROM threads WHERE key=?", {tk});
                unchanged = !old.empty() && old[0]["signature"] == signature;
            }
            if (!unchanged) {
                auto messages = read_messages(meta, history.get());
                json public_meta = {{"id", tid},        {"title", title},   {"cwd", cwd},
                                    {"repo", repo},     {"branch", branch}, {"source_id", sid},
                                    {"project_key", pk}};
                std::lock_guard lock(mutex);
                Db db(db_path());
                db.exec("BEGIN IMMEDIATE");
                try {
                    db.run("INSERT INTO projects(key,source_id,name,path,repo) VALUES(?,?,?,?,?) "
                           "ON CONFLICT(key) DO UPDATE SET "
                           "name=excluded.name,path=excluded.path,repo=excluded.repo",
                           {pk, sid, pn, cwd, repo});
                    db.run("INSERT INTO "
                           "threads(key,source_id,thread_id,title,cwd,project_key,repo,branch,"
                           "archived,created_at,updated_at,signature,content_available,metadata) "
                           "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET "
                           "title=excluded.title,cwd=excluded.cwd,project_key=excluded.project_key,"
                           "repo=excluded.repo,branch=excluded.branch,archived=excluded.archived,"
                           "updated_at=excluded.updated_at,signature=excluded.signature,content_"
                           "available=excluded.content_available,metadata=excluded.metadata",
                           {tk, sid, tid, title, cwd, pk, repo, branch,
                            str(meta, "archived") == "1" ? 1 : 0, str(meta, "created_at"),
                            str(meta, "updated_at"), signature, messages.empty() ? 0 : 1,
                            public_meta.dump()});
                    // Preserve embeddings for unchanged chunks while atomically replacing a chat.
                    auto old = db.query(
                        "SELECT id,digest FROM chunks WHERE thread_key=? AND embedded=1", {tk});
                    std::map<std::string, int64_t> reuse;
                    for (const auto &r : old)
                        reuse[str(r, "digest")] = r["id"].get<int64_t>();
                    json chunks = json::array();
                    if (messages.empty())
                        messages.push_back({{"id", "metadata"},
                                            {"turn_id", ""},
                                            {"role", "metadata"},
                                            {"ordinal", 0},
                                            {"text", title + "\n" + cwd + "\n" + repo}});
                    for (const auto &m : messages)
                        for (const auto &[offset, text] : split_text(str(m, "text"))) {
                            auto digest = hash(title + std::string(1, '\0') + text);
                            db.run("INSERT INTO "
                                   "chunks(thread_key,item_id,turn_id,role,ordinal,byte_offset,"
                                   "title,text,digest) VALUES(?,?,?,?,?,?,?,?,?)",
                                   {tk, m["id"], m["turn_id"], m["role"], m["ordinal"], offset,
                                    title, text, digest});
                            auto id = sqlite3_last_insert_rowid(db.handle);
                            chunks.push_back(id);
                            if (reuse.contains(digest)) {
                                db.run("INSERT INTO chunk_vectors(chunk_id,embedding) SELECT "
                                       "?,embedding FROM chunk_vectors WHERE chunk_id=?",
                                       {id, reuse[digest]});
                                db.run("UPDATE chunks SET embedded=1 WHERE id=?", {id});
                            }
                        }
                    // Only old rows are removed; new chunk ids are monotonically larger.
                    if (!chunks.empty()) {
                        auto first = chunks[0].get<int64_t>();
                        db.run("DELETE FROM chunk_vectors WHERE chunk_id IN (SELECT id FROM chunks "
                               "WHERE thread_key=? AND id<?)",
                               {tk, first});
                        db.run("DELETE FROM chunks WHERE thread_key=? AND id<?", {tk, first});
                    }
                    db.exec("UPDATE settings SET value=CAST(value AS INTEGER)+1 WHERE key='corpus_revision'");
                    db.exec("COMMIT");
                } catch (...) {
                    db.exec("ROLLBACK");
                    throw;
                }
            }
            {
                std::lock_guard lock(mutex);
                progress["done"] = ++done;
            }
        }
        {
            std::lock_guard lock(mutex);
            Db db(db_path());
            db.exec("BEGIN IMMEDIATE");
            if (data.warnings.empty()) {
                json observed = json::array();
                for (const auto &[id, meta] : data.threads) observed.push_back(key(sid, id));
                auto gone = db.query("SELECT key FROM threads WHERE source_id=? AND key NOT IN (SELECT value FROM json_each(?))", {sid, observed.dump()});
                for (const auto &row : gone) {
                    db.run("DELETE FROM chunk_vectors WHERE chunk_id IN (SELECT id FROM chunks WHERE thread_key=?)", {row["key"]});
                    db.run("DELETE FROM threads WHERE key=?", {row["key"]});
                }
                if (!gone.empty()) db.exec("UPDATE settings SET value=CAST(value AS INTEGER)+1 WHERE key='corpus_revision'");
            }
            db.run("UPDATE sources SET last_sync=?,warnings=? WHERE id=?",
                   {now(), json(data.warnings).dump(), sid});
            db.exec("COMMIT");
        }
    }
    std::lock_guard lock(mutex);
    if (!embedding)
        progress["phase"] = "idle";
}
void Engine::embed() {
    // Keep the connection and vector pages warm across batches.
    Db db(db_path());
    while (!stopping && !paused) {
        auto read_start = std::chrono::steady_clock::now();
        json rows;
        {
            std::lock_guard lock(mutex);
            rows = db.query(
                "SELECT c.id,c.title,c.text,c.digest FROM chunks c JOIN threads t ON t.key=c.thread_key WHERE c.embedded=0 AND t.source_id NOT IN (SELECT value FROM json_each(?)) ORDER BY c.id LIMIT ?",
                {preferences["disabled_sources"].dump(), resource_profile == 0 ? 8 : 32});
            auto counts = db.query("SELECT count(*) total,COALESCE(sum(c.embedded),0) done FROM chunks c "
                                   "JOIN threads t ON t.key=c.thread_key WHERE t.source_id NOT IN "
                                   "(SELECT value FROM json_each(?))", {preferences["disabled_sources"].dump()})[0];
            progress = {{"phase", "embedding"},
                        {"done", counts["done"]},
                        {"total", counts["total"]},
                        {"error", nullptr}};
        }
        if (rows.empty())
            break;
        {
            std::lock_guard profile_lock(performance_mutex);
            performance["read_ms"] = performance["read_ms"].get<double>() +
                                     std::chrono::duration<double, std::milli>(
                                         std::chrono::steady_clock::now() - read_start)
                                         .count();
        }
        std::vector<std::string> inputs;
        for (const auto &r : rows) {
            auto title = str(r, "title");
            if (title.size() > 512)
                title = split_text(title, 512, 0).front().second;
            inputs.push_back("title: " + title + " | text: " + str(r, "text"));
        }
        auto vectors = encode(inputs);
        auto write_start = std::chrono::steady_clock::now();
        {
            std::lock_guard lock(mutex);
            db.exec("BEGIN IMMEDIATE");
            try {
                for (size_t i = 0; i < rows.size(); ++i) {
                    auto id = rows[i]["id"].get<int64_t>();
                    if (db.query("SELECT id FROM chunks WHERE id=? AND digest=?",
                                 {id, rows[i]["digest"]})
                            .empty())
                        continue;
                    db.blob("INSERT OR REPLACE INTO chunk_vectors(chunk_id,embedding) VALUES(?,?)",
                            id, vectors[i]);
                    db.run("UPDATE chunks SET embedded=1 WHERE id=?", {id});
                }
                db.exec("COMMIT");
            } catch (...) {
                db.exec("ROLLBACK");
                throw;
            }
        }
        {
            std::lock_guard profile_lock(performance_mutex);
            performance["write_ms"] = performance["write_ms"].get<double>() +
                                      std::chrono::duration<double, std::milli>(
                                          std::chrono::steady_clock::now() - write_start)
                                          .count();
        }
        int delay = resource_profile == 0 ? 10 : resource_profile == 1 ? 2 : 0;
        for (int i = 0; i < delay && !stopping && !paused; ++i) std::this_thread::sleep_for(std::chrono::milliseconds(100));
    }
    std::lock_guard lock(mutex);
    progress["phase"] = "idle";
}
json Engine::dispatch(const std::string &method, const json &params) {
    if (method == "search_status" || method == "open_search") return status();
    if (method == "search_filters") return tree();
    if (method == "read_settings") return read_settings();
    if (method == "update_settings") return update_settings(params);
    if (method == "settings_action") return settings_action(params);
    if (method == "search_chats") {
        {std::lock_guard lock(mutex); if (!preferences.value("agent_access", true)) throw ServiceFailure("AGENT_ACCESS_DISABLED");}
        return search(params);
    }
    if (method == "search_panel") return search(params);
    if (method == "manage_index") {
        auto action = str(params, "action");
        if (action == "refresh") return start_index();
        if (action == "resume") return start_embeddings();
        throw std::runtime_error("Invalid index action");
    }
    throw std::runtime_error("Unknown method");
}
} // namespace bettersearch
