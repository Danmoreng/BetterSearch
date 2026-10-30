#include "search.hpp"
#include <algorithm>
#include <regex>
#ifdef _WIN32
#include <windows.h>
#endif

namespace bettersearch {
static void save_json(const fs::path &file, const json &value) {
    auto temporary = file; temporary += ".tmp";
    write_file(temporary, value.dump(2));
#ifdef _WIN32
    if (!MoveFileExW(temporary.c_str(), file.c_str(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH))
        throw ServiceFailure("SAVE_FAILED");
#else
    fs::rename(temporary, file);
#endif
}
static json defaults() {
    return {{"include_archived", true}, {"density", "comfortable"}, {"automatic_updates", true},
            {"profile", "balanced"}, {"paused", false}, {"agent_access", true},
            {"language", "auto"}, {"disabled_sources", json::array()}};
}
void Engine::init_preferences() {
    preferences = defaults();
    if (fs::exists(home / "preferences.json")) {
        auto saved = json::parse(read_file(home / "preferences.json"));
        for (auto &[name, value] : preferences.items()) if (saved.contains(name)) value = saved[name];
    }
    paused = preferences.value("paused", false);
    automatic_updates = preferences.value("automatic_updates", true);
    auto profile = str(preferences, "profile", "balanced");
    resource_profile = profile == "efficient" ? 0 : profile == "fast" ? 2 : 1;
}
json Engine::read_settings() {
    std::lock_guard lock(mutex);
    auto state = status();
    auto sources = config["sources"];
    for (auto &source : sources) {
        source["enabled"] = std::find(preferences["disabled_sources"].begin(), preferences["disabled_sources"].end(), source["id"]) == preferences["disabled_sources"].end();
        source["last_sync"] = nullptr; source["warning"] = false;
        for (const auto &s : state["sources"]) if (s["id"] == source["id"]) {
            source["last_sync"] = s["last_sync"];
            source["warning"] = !s["warnings"].is_null() && s["warnings"] != "[]" && s["warnings"] != "";
        }
    }
    json model = {{"phase", state["model_ready"].get<bool>() ? "ready" : "missing"}, {"bytes", 0}, {"total", 558000000}};
    try {
        auto job = json::parse(read_file(home / "model-setup.json"));
        if (model_installing || str(job, "phase") == "error") model = job;
    } catch (...) {}
    if (model_installing && str(model, "phase") == "missing") model["phase"] = "checking";
    auto model_path = fs::u8path(str(config, "model_file"));
    std::error_code error;
    auto bytes = fs::file_size(model_path, error);
    model["installed_bytes"] = error ? 0 : bytes;
    model["busy"] = model_installing.load();
    return {{"preferences", preferences}, {"sources", sources}, {"status", state}, {"model", model}};
}
json Engine::update_settings(const json &params) {
    std::lock_guard lock(mutex);
    if (!params.is_object()) throw ServiceFailure("INVALID_SETTING");
    auto next = preferences;
    for (const auto &[name, value] : params.items()) {
        if (name == "include_archived" || name == "automatic_updates" || name == "paused" || name == "agent_access") {
            if (!value.is_boolean()) throw ServiceFailure("INVALID_SETTING");
        } else if (name == "density") {
            if (value != "compact" && value != "comfortable") throw ServiceFailure("INVALID_SETTING");
        } else if (name == "profile") {
            if (value != "efficient" && value != "balanced" && value != "fast") throw ServiceFailure("INVALID_SETTING");
        } else if (name == "language") {
            if (value != "auto" && value != "en") throw ServiceFailure("INVALID_SETTING");
        } else throw ServiceFailure("INVALID_SETTING");
        next[name] = value;
    }
    bool was_paused = paused;
    save_json(home / "preferences.json", next);
    preferences = next;
    paused = next["paused"].get<bool>(); automatic_updates = next["automatic_updates"].get<bool>();
    auto profile = str(next, "profile"); resource_profile = profile == "efficient" ? 0 : profile == "fast" ? 2 : 1;
    if (was_paused && !paused) {embedding_pending = true; start_index();}
    return read_settings();
}

json Engine::diagnostics() {
    std::lock_guard lock(mutex);
    auto s = status();
    // Explicit allowlist: no excerpts, source labels, paths, tokens or raw errors.
    json report = {{"version", BETTER_SEARCH_VERSION}, {"backend", "cpu-only"}, {"source_count", config["sources"].size()},
                   {"profile", preferences["profile"]}, {"automatic_updates", automatic_updates.load()}, {"paused", paused.load()}};
    for (auto name : {"threads", "projects", "chunks", "embedded", "model_ready", "database_bytes", "indexing", "embedding"}) report[name] = s[name];
    report["query_backend"] = s["query_backend"];
    report["index_backend"] = s["performance"].value("backend", "not-started");
    report["phase"] = s["progress"]["phase"];
    report["has_error"] = !s["progress"]["error"].is_null();
    report["created_at"] = now();
    return report;
}
json Engine::settings_action(const json &params) {
    auto action = str(params, "action");
    if (action == "diagnostics") return diagnostics();
    if (action == "export_diagnostics") {
        auto report = diagnostics();
        auto file = choose_path(true, stopping);
        if (file.empty()) return {{"cancelled", true}};
        write_file(file, report.dump(2));
        return {{"saved", true}};
    }
    fs::path selected;
    if (action == "add_source") {
        selected = choose_path(false, stopping);
        if (selected.empty()) return {{"cancelled", true}};
    }
    // Wait for in-flight retrieval before replacing active index contents.
    // Always acquire this gate before the engine mutex, matching search order.
    std::unique_lock maintenance_lock(maintenance_mutex, std::defer_lock);
    if (action == "clear" || action == "rebuild") maintenance_lock.lock();
    std::unique_lock lock(mutex);
    if (action == "source_enabled") {
        auto id = str(params, "id");
        bool found = false; for (const auto &s : config["sources"]) if (s["id"] == id) found = true;
        if (!found || !params.contains("enabled") || !params["enabled"].is_boolean()) throw ServiceFailure("INVALID_SOURCE");
        auto next = preferences; auto &disabled = next["disabled_sources"];
        disabled.erase(std::remove(disabled.begin(), disabled.end(), json(id)), disabled.end());
        if (!params["enabled"].get<bool>()) disabled.push_back(id);
        save_json(home / "preferences.json", next); preferences = next;
        Db db(db_path()); db.exec("UPDATE settings SET value=CAST(value AS INTEGER)+1 WHERE key='corpus_revision'");
        {std::lock_guard cache_lock(cache_mutex); search_snapshots.clear(); result_cache.clear();}
        if (params["enabled"].get<bool>() && !paused) {embedding_pending = true; start_index();}
        return read_settings();
    }
    if (action == "add_source" || action == "rename_source") {
        if (indexing || embedding || model_installing) throw ServiceFailure("INDEX_BUSY");
        auto next = config;
        json source;
        if (action == "add_source") {
            selected = fs::weakly_canonical(selected);
            try {scan_source({{"codex_home", utf8(selected)}});}
            catch (...) {throw ServiceFailure("INVALID_SOURCE");}
            for (const auto &s : next["sources"]) {
                auto other = fs::weakly_canonical(fs::u8path(str(s, "codex_home")));
#ifdef _WIN32
                bool same = CompareStringOrdinal(selected.c_str(), -1, other.c_str(), -1, TRUE) == CSTR_EQUAL;
#else
                bool same = selected == other;
#endif
                if (same) throw ServiceFailure("SOURCE_EXISTS");
            }
            source = {{"id", "local-" + hash(utf8(selected)).substr(0, 16)}, {"label", utf8(selected.filename())},
                      {"kind", "local"}, {"codex_home", utf8(selected)}};
            next["sources"].push_back(source);
        } else {
            auto label = clean_text(str(params, "label"));
            if (label.empty() || label.size() > 100) throw ServiceFailure("INVALID_LABEL");
            for (auto &s : next["sources"]) if (s["id"] == str(params, "id")) {s["label"] = label; source = s;}
            if (source.is_null()) throw ServiceFailure("INVALID_SOURCE");
        }
        save_json(home / "config.json", next); config = next;
        Db db(db_path());
        db.run("INSERT INTO sources(id,label,root,kind) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET label=excluded.label", {source["id"],source["label"],source["codex_home"],"local"});
        db.run("INSERT OR IGNORE INTO source_identities(source_id,origin_id) VALUES(?,lower(hex(randomblob(16))))", {source["id"]});
        db.exec("UPDATE settings SET value=CAST(value AS INTEGER)+1 WHERE key='corpus_revision'");
        if (action == "add_source" && !paused) {embedding_pending = true; start_index();}
        return read_settings();
    }
    if (action == "install_model") {
        if (model_installing) return {{"started", false}};
        if (indexing || embedding) throw ServiceFailure("INDEX_BUSY");
        if (model_thread.joinable()) model_thread.join();
        model_installing = true;
        save_json(home / "model-setup.json", {{"phase", "checking"}});
        model_thread = std::thread([this] {
            bool ok = false;
            try {
                ok = run_model_helper(home, stopping);
                if (ok) {
                    auto model = json::parse(read_file(home / "model-setup.json"));
                    std::scoped_lock inference_lock(inference_mutex, query_inference_mutex);
                    std::lock_guard model_lock(mutex);
                    auto next = config; next["model_file"] = model.at("model_file");
                    save_json(home / "config.json", next); config = next;
                    index_inference.reset(); query_inference.reset();
                    embedding_error.clear();
                    embedding_pending = true;
                }
            } catch (...) {ok = false;}
            if (!ok) {try {save_json(home / "model-setup.json", {{"phase", "error"}, {"code", "MODEL_SETUP_FAILED"}});} catch (...) {}}
            model_installing = false;
        });
        return {{"started", true}};
    }
    if (action == "refresh" || action == "repair") {
        if (paused || model_installing) throw ServiceFailure("INDEX_PAUSED");
        lock.unlock(); return start_index();
    }
    if (action == "rebuild" || action == "clear") {
        if (!params.value("confirmed", false)) throw ServiceFailure("CONFIRMATION_REQUIRED");
        if (indexing || embedding || model_installing) throw ServiceFailure("INDEX_BUSY");
        Db db(db_path());
        db.backup(home / "backups" / ("search-" + action + "-" + hash(now()).substr(0, 16) + ".sqlite"));
        db.exec("BEGIN IMMEDIATE");
        try {
            db.exec("DELETE FROM chunk_vectors; DELETE FROM chunks; DELETE FROM threads; DELETE FROM projects; UPDATE sources SET last_sync=NULL,warnings=NULL; UPDATE settings SET value=CAST(value AS INTEGER)+1 WHERE key='corpus_revision'; UPDATE settings SET value='0' WHERE key='initial_embedding_complete'; COMMIT");
        } catch (...) {db.exec("ROLLBACK"); throw;}
        {std::lock_guard cache_lock(cache_mutex); result_cache.clear(); search_snapshots.clear();}
        initial_embedding = true;
        progress = {{"phase", "idle"}, {"done", 0}, {"total", 0}, {"error", nullptr}};
        embedding_error.clear();
        index_pending = false;
        auto next = preferences; next["paused"] = action == "clear";
        save_json(home / "preferences.json", next); preferences = next; paused = action == "clear";
        embedding_pending = action == "rebuild";
        if (action == "clear") return {{"cleared", true}};
        lock.unlock(); return start_index();
    }
    throw ServiceFailure("INVALID_ACTION");
}
} // namespace bettersearch
