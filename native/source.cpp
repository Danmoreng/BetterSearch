#include "search.hpp"
#include <algorithm>
#include <regex>
#include <set>

namespace bettersearch {
static bool guardian_review(const json &meta) {
    if (str(meta, "thread_source") == "guardian_review") return true;
    auto source = meta.value("source", json());
    if (source.is_string()) source = json::parse(source.get<std::string>(), nullptr, false);
    if (!source.is_object()) return false;
    auto subagent = source.find("subagent");
    return subagent != source.end() && subagent->is_object() && str(*subagent, "other") == "guardian";
}
static std::string local_repository(const std::string &cwd) {
    try {
        auto folder = fs::u8path(cwd);
        if (!fs::is_directory(folder))
            return "";
        for (int depth = 0; depth < 16 && !folder.empty(); ++depth) {
            auto dotgit = folder / ".git";
            if (fs::exists(dotgit)) {
                auto gitdir = dotgit;
                if (fs::is_regular_file(dotgit)) {
                    auto line = clean_text(read_file(dotgit));
                    if (!line.starts_with("gitdir:"))
                        return "";
                    gitdir = fs::weakly_canonical(folder / fs::u8path(clean_text(line.substr(7))));
                }
                if (fs::is_regular_file(gitdir / "commondir"))
                    gitdir = fs::weakly_canonical(
                        gitdir / fs::u8path(clean_text(read_file(gitdir / "commondir"))));
                if (fs::is_regular_file(gitdir / "config")) {
                    std::ifstream config(gitdir / "config");
                    std::string line;
                    bool origin = false;
                    while (std::getline(config, line)) {
                        line = clean_text(line);
                        if (line.starts_with("["))
                            origin = line == "[remote \"origin\"]";
                        else if (origin && line.starts_with("url")) {
                            auto eq = line.find('=');
                            if (eq != std::string::npos)
                                return normalize_origin(clean_text(line.substr(eq + 1)));
                        }
                    }
                }
                return utf8(gitdir.filename() == ".git" ? gitdir.parent_path() : folder);
            }
            auto parent = folder.parent_path();
            if (parent == folder)
                break;
            folder = parent;
        }
    } catch (const std::exception &) {
    }
    return "";
}
static bool has_table(Db &db, const std::string &name) {
    return !db.query("SELECT name FROM sqlite_master WHERE type='table' AND name=?", {name})
                .empty();
}
static fs::path newest(const fs::path &dir, const std::string &prefix) {
    fs::path result;
    int version = -1;
    if (!fs::is_directory(dir))
        return {};
    for (const auto &e : fs::directory_iterator(dir)) {
        auto name = utf8(e.path().filename());
        if (name.starts_with(prefix) && name.ends_with(".sqlite")) {
            try {
                int n = std::stoi(name.substr(prefix.size()));
                if (n > version) {
                    result = e.path();
                    version = n;
                }
            } catch (...) {
            }
        }
    }
    return result;
}
SourceData scan_source(const json &source) {
    SourceData out;
    bool recognized = false;
    auto root = fs::u8path(source.at("codex_home").get<std::string>());
    if (!fs::is_directory(root))
        throw std::runtime_error("Codex source unavailable: " + utf8(root));
    for (const auto &dir : {root, root / "sqlite"}) {
        auto p = newest(dir, "state_");
        if (p.empty())
            continue;
        try {
            Db db(p, true);
            db.exec("BEGIN");
            if (!has_table(db, "threads")) {
                out.warnings.push_back("Unsupported state schema: threads table missing");
                continue;
            }
            recognized = true;
            if (has_table(db, "projects")) {
                for (auto &project : db.query("SELECT * FROM projects"))
                    out.projects.try_emplace(str(project, "id"), project);
            }
            for (auto &t : db.query("SELECT * FROM threads")) {
                auto id = str(t, "id");
                if (guardian_review(t)) {out.excluded_threads.insert(id); continue;}
                auto title = clean_text(str(t, "name"));
                if (title.empty())
                    title = clean_text(str(t, "title"));
                t["title"] = title.empty() ? "Untitled chat" : title;
                t["git_origin_url"] = normalize_origin(str(t, "git_origin_url"));
                out.threads.try_emplace(id, std::move(t));
            }
            db.exec("COMMIT");
        } catch (const std::exception &e) {
            out.warnings.push_back(utf8(p.filename()) + ": " + e.what());
        }
    }
    std::map<std::string, std::string> titles;
    auto index = root / "session_index.jsonl";
    if (fs::exists(index)) {
        std::ifstream f(index);
        std::string line;
        while (std::getline(f, line)) {
            auto j = json::parse(line, nullptr, false);
            if (!j.is_discarded())
                titles[str(j, "id")] = str(j, "thread_name", str(j, "title"));
        }
    }
    for (const auto &folder : {root / "sessions", root / "archived_sessions"})
        if (fs::is_directory(folder)) {
            recognized = true;
            for (const auto &e : fs::recursive_directory_iterator(
                     folder, fs::directory_options::skip_permission_denied)) {
                auto filename = utf8(e.path().filename());
                if (!e.is_regular_file() ||
                    (!filename.ends_with(".jsonl") && !filename.ends_with(".jsonl.zst")))
                    continue;
                try {
                    json j;
                    each_rollout_line(e.path(), [&](const std::string &line, int64_t) {
                        j = json::parse(line, nullptr, false);
                        return false;
                    });
                    if (j.is_discarded() || str(j, "type") != "session_meta")
                        continue;
                    auto p = j.at("payload");
                    auto id = str(p, "id", str(p, "session_id"));
                    if (id.empty())
                        continue;
                    if (guardian_review(p)) out.excluded_threads.insert(id);
                    if (out.excluded_threads.contains(id)) continue;
                    if (!out.threads.contains(id)) {
                        auto title = titles.contains(id) ? titles[id] : "Untitled chat";
                        out.threads[id] = {
                            {"id", id},
                            {"title", title},
                            {"cwd", str(p, "cwd")},
                            {"archived", utf8(folder.filename()) == "archived_sessions" ? 1 : 0},
                            {"created_at", str(p, "timestamp")},
                            {"updated_at", str(j, "timestamp")}};
                    }
                    out.threads[id]["_rollout"] = utf8(e.path());
                } catch (const std::exception &) {
                    out.warnings.push_back("Unreadable rollout: " + utf8(e.path().filename()));
                }
            }
        }
    for (const auto &id : out.excluded_threads) out.threads.erase(id);
    out.history = newest(root, "thread_history_");
    if (out.history.empty())
        out.history = newest(root / "sqlite", "thread_history_");
    if (!out.history.empty()) {
        try {
            Db db(out.history, true);
            auto hasUpdated = !db.query("SELECT name FROM pragma_table_info('thread_items') WHERE "
                                        "name='updated_at_ordinal'")
                                   .empty();
            auto rows = db.query("SELECT thread_id,count(*) n,max(rollout_ordinal) "
                                 "last,sum(length(item_json)) bytes" +
                                 std::string(hasUpdated ? ",max(updated_at_ordinal) edited" : "") +
                                 " FROM thread_items WHERE item_type IN "
                                 "('userMessage','agentMessage') GROUP BY thread_id");
            for (const auto &r : rows) {
                auto id = str(r, "thread_id");
                if (out.threads.contains(id))
                    out.threads[id]["_history_signature"] = r.dump();
            }
        } catch (const std::exception &e) {
            out.warnings.push_back("History schema: " + std::string(e.what()));
        }
    }
    std::map<std::string, std::string> repository_cache;
    for (auto &[id, meta] : out.threads) {
        auto repo = normalize_origin(str(meta, "git_origin_url")), cwd = str(meta, "cwd");
        if (repo.empty() && !cwd.empty()) {
            if (!repository_cache.contains(cwd))
                repository_cache[cwd] = local_repository(cwd);
            repo = repository_cache[cwd];
        }
        meta["_repository"] = repo;
    }
    if (!recognized) throw std::runtime_error("No supported Codex history found in configured source");
    if (out.threads.empty() && !out.warnings.empty())
        throw std::runtime_error("Cannot read source schema: " + out.warnings.front());
    return out;
}
static std::string text_parts(const json &a) {
    std::string r;
    if (!a.is_array())
        return r;
    for (const auto &p : a) {
        auto type = str(p, "type");
        if (type == "text" || type == "input_text" || type == "output_text") {
            if (!r.empty())
                r += '\n';
            r += str(p, "text");
        }
    }
    return r;
}
json read_messages(const json &meta, Db *history) {
    json messages = json::array();
    std::set<std::string> ids, texts;
    if (history) {
        for (const auto &row :
             history->query("SELECT item_id,turn_id,rollout_ordinal,created_at_ms,item_json FROM "
                            "thread_items WHERE thread_id=? AND item_type IN "
                            "('userMessage','agentMessage') ORDER BY rollout_ordinal,item_id",
                            {meta["id"]})) {
            auto item = json::parse(str(row, "item_json"), nullptr, false);
            if (item.is_discarded())
                continue;
            auto role = str(item, "type") == "userMessage" ? "user" : "assistant";
            auto text = clean_text(std::string(role) == "user"
                                       ? text_parts(item.value("content", json::array()))
                                       : str(item, "text"));
            if (text.empty())
                continue;
            auto id = str(row, "item_id");
            messages.push_back({{"id", id},
                                {"turn_id", row["turn_id"]},
                                {"role", role},
                                {"text", text},
                                {"ordinal", row["rollout_ordinal"]},
                                {"timestamp", row["created_at_ms"]}});
            ids.insert(id);
            texts.insert(hash(std::string(role) + "\0" + text));
        }
    }
    auto path = fs::u8path(str(meta, "_rollout", str(meta, "rollout_path")));
    // Compressed files are closed rollouts. The paginated projection is
    // canonical when present; decoding is needed for legacy/missing histories.
    if (fs::is_regular_file(path) && (messages.empty() || path.extension() != ".zst")) {
        std::string turn;
        json responses = json::array(), events = json::array();
        each_rollout_line(path, [&](const std::string &line, int64_t n) {
            auto j = json::parse(line, nullptr, false);
            if (j.is_discarded() || !j.contains("payload"))
                return true;
            auto &p = j["payload"];
            auto type = str(j, "type");
            if (type == "turn_context")
                turn = str(p, "turn_id");
            json m;
            if (type == "response_item" && str(p, "type") == "message" &&
                (str(p, "role") == "user" || str(p, "role") == "assistant")) {
                m = {{"id", str(p, "id", "rollout-" + std::to_string(n))},
                     {"role", p["role"]},
                     {"text", clean_text(text_parts(p.value("content", json::array())))}};
            } else if (type == "event_msg" &&
                       (str(p, "type") == "user_message" || str(p, "type") == "agent_message")) {
                m = {{"id", "event-" + std::to_string(n)},
                     {"role", str(p, "type") == "user_message" ? "user" : "assistant"},
                     {"text", clean_text(str(p, "message"))}};
            } else
                return true;
            m["turn_id"] = turn;
            m["ordinal"] = j.value("ordinal", n);
            m["timestamp"] = str(j, "timestamp");
            if (type == "response_item")
                responses.push_back(m);
            else
                events.push_back(m);
            return true;
        });
        // Real message IDs are authoritative: identical messages in distinct
        // turns must survive. Only the legacy event stream duplicates messages.
        std::map<std::string, size_t> history_count, response_count;
        for (const auto &m : messages)
            ++history_count[hash(str(m, "role") + ":" + str(m, "text"))];
        for (const auto &m : responses) {
            auto id = str(m, "id"), text = str(m, "text");
            auto sig = hash(str(m, "role") + ":" + text);
            if (id.starts_with("rollout-") && ++response_count[sig] <= history_count[sig])
                continue;
            if (!text.empty() && !ids.contains(id)) {
                messages.push_back(m);
                ids.insert(id);
            }
        }
        std::map<std::string, size_t> canonical_count, event_count;
        for (const auto &m : messages)
            ++canonical_count[hash(str(m, "role") + ":" + str(m, "text"))];
        for (const auto &m : events) {
            auto text = str(m, "text"), sig = hash(str(m, "role") + ":" + text);
            if (!text.empty() && ++event_count[sig] > canonical_count[sig])
                messages.push_back(m);
        }
    }
    std::stable_sort(messages.begin(), messages.end(), [](const json &a, const json &b) {
        return a["ordinal"].get<int64_t>() < b["ordinal"].get<int64_t>();
    });
    return messages;
}
} // namespace bettersearch
