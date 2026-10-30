#include "search.hpp"
#include <algorithm>
#include <cmath>
#include <regex>
#include <set>

namespace bettersearch {
using Clock = std::chrono::steady_clock;
static double elapsed(Clock::time_point start) {
    return std::chrono::duration<double, std::milli>(Clock::now() - start).count();
}
static int64_t filter_date(const std::string &value) {
    if (!std::regex_match(value, std::regex("[0-9]{4}-[0-9]{2}-[0-9]{2}")))
        throw ServiceFailure("SEARCH_FILTER_INVALID");
    using namespace std::chrono;
    auto year_value = std::stoi(value.substr(0, 4));
    year_month_day date{year{year_value}, month{static_cast<unsigned>(std::stoi(value.substr(5, 2)))},
        day{static_cast<unsigned>(std::stoi(value.substr(8, 2)))}};
    if (year_value < 1 || !date.ok()) throw ServiceFailure("SEARCH_FILTER_INVALID");
    return duration_cast<seconds>(sys_days{date}.time_since_epoch()).count();
}
static double filter_boundary(const std::string &value, bool end) {
    if (value.size() == 10) return static_cast<double>(filter_date(value) + (end ? 86400 : 0));
    std::smatch match;
    if (!std::regex_match(value, match, std::regex("([0-9]{4}-[0-9]{2}-[0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(\\.[0-9]{1,9})?Z")))
        throw ServiceFailure("SEARCH_FILTER_INVALID");
    int hour = std::stoi(match[2]), minute = std::stoi(match[3]), second = std::stoi(match[4]);
    if (hour > 23 || minute > 59 || second > 59) throw ServiceFailure("SEARCH_FILTER_INVALID");
    return static_cast<double>(filter_date(match[1]) + hour * 3600 + minute * 60 + second) +
        (match[5].matched ? std::stod(match[5]) : 0.0);
}
struct SearchTerms { std::string lexical; std::vector<std::string> phrases; };
static SearchTerms search_terms(const std::string &value) {
    std::regex words("[A-Za-z0-9_\x80-\xff]+");
    SearchTerms result;
    std::vector<std::pair<std::string, bool>> terms;
    auto add = [&](const std::string &part, bool phrase) {
        std::string group;
        for (auto i = std::sregex_iterator(part.begin(), part.end(), words); i != std::sregex_iterator(); ++i) {
            if (!phrase) terms.emplace_back('"' + i->str() + '"', false);
            else { if (!group.empty()) group += ' '; group += i->str(); }
        }
        if (phrase) {
            if (group.empty()) throw ServiceFailure("SEARCH_QUERY_INVALID");
            auto term = '"' + group + '"';
            terms.emplace_back(term, true); result.phrases.push_back(term);
        }
    };
    size_t start = 0; bool quoted = false;
    for (size_t i = 0; i < value.size(); ++i) if (value[i] == '"') {
        add(value.substr(start, i - start), quoted); start = i + 1; quoted = !quoted;
    }
    if (quoted) throw ServiceFailure("SEARCH_QUERY_INVALID");
    add(value.substr(start), false);
    std::sort(result.phrases.begin(), result.phrases.end());
    result.phrases.erase(std::unique(result.phrases.begin(), result.phrases.end()), result.phrases.end());
    if (result.phrases.size() > 32) throw ServiceFailure("SEARCH_QUERY_INVALID");
    // Unquoted terms retain the existing OR/prefix retrieval behavior. Quoted phrases
    // stay intact for excerpts and are additionally mandatory at the chat boundary.
    for (size_t i = 0; i < terms.size() && i < 32; ++i) {
        if (!result.lexical.empty()) result.lexical += " OR ";
        result.lexical += terms[i].first;
        if (i + 1 == terms.size() && !terms[i].second) result.lexical += '*';
    }
    return result;
}
static std::string filters(const json &p, json &args, const std::vector<std::string> &phrases) {
    std::string sql = "1=1";
    for (auto field : {"source_id", "project_key", "repo"}) {
        auto value = str(p, field);
        if (!value.empty()) { sql += " AND t." + std::string(field) + "=?"; args.push_back(value); }
    }
    if (p.contains("project_keys")) {
        if (!p["project_keys"].is_array() || p["project_keys"].size()>500)
            throw std::runtime_error("Invalid project filter");
        sql += " AND t.project_key IN (SELECT value FROM json_each(?))";
        args.push_back(p["project_keys"].dump());
    }
    if (!p.value("include_archived", true)) sql += " AND t.archived=0";
    if (p.contains("_disabled_sources")) {
        sql += " AND t.source_id NOT IN (SELECT value FROM json_each(?))";
        args.push_back(p["_disabled_sources"].dump());
    }
    for (auto field : {"updated_after", "updated_before"})
        if (p.contains(field) && !p[field].is_string()) throw ServiceFailure("SEARCH_FILTER_INVALID");
    auto after = str(p, "updated_after"), before = str(p, "updated_before");
    if (!after.empty() || !before.empty()) {
        // Source versions store ISO timestamps, epoch seconds or epoch milliseconds.
        // Date-only bounds select inclusive UTC days. Timestamp bounds form [start,end),
        // allowing the UI to send local calendar boundaries, including daylight-saving changes.
        const std::string updated = "(CASE WHEN trim(t.updated_at)<>'' AND "
            "ltrim(trim(t.updated_at),'-') NOT GLOB '*[^0-9.]*' AND t.updated_at GLOB '*[0-9]*' "
            "THEN CAST(t.updated_at AS REAL)/(CASE WHEN abs(CAST(t.updated_at AS REAL))>=100000000000 "
            "THEN 1000.0 ELSE 1 END) ELSE unixepoch(t.updated_at,'subsec') END)";
        auto lower = after.empty() ? 0.0 : filter_boundary(after, false);
        auto upper = before.empty() ? 0.0 : filter_boundary(before, true);
        if (!after.empty() && !before.empty() && lower >= upper) throw ServiceFailure("SEARCH_FILTER_INVALID");
        if (!after.empty()) { sql += " AND " + updated + ">=?"; args.push_back(lower); }
        if (!before.empty()) { sql += " AND " + updated + "<?"; args.push_back(upper); }
    }
    for (const auto &phrase : phrases) {
        // Every quoted phrase must occur together in an original message or the chat
        // title. Synthetic metadata text also contains paths/repos, so exclude it.
        sql += " AND t.key IN (SELECT required.thread_key FROM chunks_fts "
            "JOIN chunks required ON required.id=chunks_fts.rowid "
            "WHERE required.role IN ('user','assistant') AND chunks_fts MATCH ? "
            "UNION SELECT titled.thread_key FROM chunks_fts JOIN chunks titled ON titled.id=chunks_fts.rowid "
            "WHERE chunks_fts MATCH ?)";
        args.push_back("text : " + phrase); args.push_back("title : " + phrase);
    }
    return sql;
}
struct Snapshot {
    Db &db;
    explicit Snapshot(Db &d) : db(d) { db.exec("BEGIN"); }
    ~Snapshot() { try { db.exec("ROLLBACK"); } catch (...) {} }
};
json Engine::navigation(const json &row) {
    std::lock_guard lock(mutex);
    auto sid = str(row, "source_id"), tid = str(row, "thread_id");
    for (const auto &source : config["sources"]) if (str(source, "id") == sid) {
        // Local ownership is a source capability, never the spelling of its alias.
        if (str(source, "kind", "local") == "local" &&
            std::regex_match(tid, std::regex("[A-Za-z0-9_-]{1,100}")))
            return {{"kind", "open-original"}, {"url", "codex://threads/" + tid}, {"target", "local"}};
    }
    return {{"kind", "unavailable"}, {"reason", "The original chat is unavailable on this computer."},
            {"code", "ORIGINAL_UNAVAILABLE"}};
}
json Engine::search(const json &input) {
    std::shared_lock maintenance_lock(maintenance_mutex);
    auto p = input;
    {std::lock_guard lock(mutex); p["_disabled_sources"] = preferences["disabled_sources"];}
    auto session_id = str(p, "session_id");
    auto request_id = p.value("request_id", int64_t(0));
    bool semantic = !str(p, "query").empty() && str(p, "mode", "hybrid") != "keyword" && !p.value("cancel", false);
    std::shared_ptr<SearchSession> session;
    auto stale = [&] { return json{{"requestId", request_id}, {"discarded", true}, {"results", json::array()}}; };
    if (!session_id.empty()) {
        if (session_id.size() > 128 || request_id < 0) throw std::runtime_error("Invalid search session");
        std::unique_lock lock(session_mutex);
        if (!sessions.contains(session_id)) {
            if (sessions.size() >= 256) {
                auto old = std::find_if(sessions.begin(), sessions.end(), [](auto &s) { return !s.second->running; });
                if (old == sessions.end()) throw std::runtime_error("Too many active search sessions");
                sessions.erase(old);
            }
            sessions[session_id] = std::make_shared<SearchSession>();
        }
        session = sessions[session_id];
        session->latest = std::max(session->latest, request_id);
        session_available.notify_all();
        if (request_id < session->latest || p.value("cancel", false)) return stale();
        if (semantic) {
            session_available.wait(lock, [&] { return !session->running || session->latest != request_id; });
            if (session->latest != request_id) return stale();
            session->running = true;
        }
    }
    auto finish = [&] {
        if (session && semantic) {
            std::lock_guard lock(session_mutex); session->running = false; session_available.notify_all();
        }
    };
    try {
        std::unique_lock<std::mutex> inference_slot(query_execution_mutex, std::defer_lock);
        if (semantic) {
            inference_slot.lock();
            if (session) {
                std::lock_guard lock(session_mutex);
                if (session->latest != request_id) {
                    session->running = false; session_available.notify_all(); return stale();
                }
            }
        }
        json result;
        bool palette = str(p, "presentation") == "palette-v1" && !clean_text(str(p, "query")).empty();
        if (palette) {
            json identity = p;
            for (auto field : {"session_id", "request_id", "limit", "offset", "snapshot_id"}) identity.erase(field);
            auto query_key = identity.dump();
            auto snapshot_id = str(p, "snapshot_id");
            json full;
            if (!snapshot_id.empty()) {
                std::lock_guard lock(cache_mutex);
                auto it = std::find_if(search_snapshots.begin(), search_snapshots.end(), [&](const auto &s) {
                    return s.id == snapshot_id && s.owner == session_id && s.query == query_key &&
                        Clock::now() - s.created < std::chrono::minutes(10);
                });
                if (it == search_snapshots.end()) throw ServiceFailure("SEARCH_SNAPSHOT_EXPIRED");
                full = it->result;
            } else {
                auto request = p; request["offset"] = 0; request["limit"] = 100;
                full = search_impl(request);
                snapshot_id = hash(session_id + query_key + std::to_string(Clock::now().time_since_epoch().count()));
                std::lock_guard lock(cache_mutex);
                if (search_snapshots.size() >= 24) search_snapshots.erase(search_snapshots.begin());
                search_snapshots.push_back({snapshot_id, session_id, query_key, full, Clock::now()});
            }
            result = full; result["results"] = json::array();
            size_t offset = std::clamp(p.value("offset", 0), 0, 10000);
            size_t limit = std::clamp(p.value("limit", 6), 1, 100);
            for (size_t i = offset; i < full["results"].size() && i < offset + limit; ++i)
                result["results"].push_back(full["results"][i]);
            result["offset"] = offset; result["snapshot_id"] = snapshot_id;
            result["has_more"] = offset + result["results"].size() < full["results"].size();
        } else result = search_impl(p);
        finish();
        if (session) { std::lock_guard lock(session_mutex); if (session->latest != request_id) return stale(); }
        result["requestId"] = request_id;
        return result;
    } catch (...) { finish(); throw; }
}
json Engine::search_impl(const json &p) {
    auto start = Clock::now();
    auto query = clean_text(str(p, "query")), mode = str(p, "mode", "hybrid");
    if (query.size() > 8000) throw std::runtime_error("Search query too long");
    if (mode != "keyword" && mode != "hybrid" && mode != "semantic") throw std::runtime_error("Unknown search mode");
    int limit = std::clamp(p.value("limit", 30), 1, 100), offset = std::clamp(p.value("offset", 0), 0, 10000);
    if (query.empty()) return {{"results", json::array()}, {"query", ""}, {"mode", mode},
        {"has_more", false}, {"offset", 0}, {"warningCode", ""}};
    auto terms = search_terms(query);
    json args = json::array(); auto filter = filters(p, args, terms.phrases);
    json cache_params = p;
    for (auto field : {"session_id", "request_id"}) cache_params.erase(field);
    auto cache_base = cache_params.dump();
    {
        ReaderLease reader(*this);
        auto revision = reader.db().query("SELECT value FROM settings WHERE key='corpus_revision'")[0]["value"];
        auto cache_key = cache_base + revision.dump();
        std::lock_guard lock(cache_mutex);
        for (size_t i = 0; i < result_cache.size(); ++i) if (result_cache[i].first == cache_key) {
            auto cached = result_cache[i]; result_cache.erase(result_cache.begin() + i); result_cache.push_back(cached);
            cached.second["timings"] = {{"total_ms", elapsed(start)}, {"cached", true}};
            return cached.second;
        }
    }
    bool semantic = false;
    std::string warning;
    std::vector<float> vector;
    if (!query.empty() && mode != "keyword") {
        try {
            vector = encode({query}, true).at(0);
            semantic = true;
        } catch (const std::exception &e) { if (mode == "semantic") throw; warning = e.what(); }
    }
    double inference_ms = elapsed(start);
    ReaderLease reader(*this);
    auto &db = reader.db();
    Snapshot snapshot(db);
    auto revision = std::stoll(str(db.query("SELECT value FROM settings WHERE key='corpus_revision'")[0], "value"));
    auto fts = terms.lexical;
    struct Candidate { double score = 0; int64_t chunk = 0, semantic_chunk = 0; bool keyword = false, semantic = false, metadata = false, title = false, project = false; double similarity = 0; };
    std::map<std::string, Candidate> candidates;
    auto channel = [&](const json &rows, double weight, const std::string &kind) {
        std::set<std::string> seen;
        int rank = 0;
        for (const auto &row : rows) {
            auto key = str(row, "thread_key");
            if (!seen.insert(key).second) continue;
            auto &c = candidates[key]; c.score += weight / (60.0 + ++rank);
            if (kind == "metadata") c.metadata = true;
            if (kind == "keyword") { c.keyword = true; c.chunk = row["id"].get<int64_t>(); }
            if (kind == "semantic") {
                c.semantic = true; c.similarity = 1.0 - row["distance"].get<double>();
                c.semantic_chunk = row["id"].get<int64_t>();
                if (!c.keyword) c.chunk = row["id"].get<int64_t>();
            }
            if (!c.chunk && row.contains("id") && !row["id"].is_null()) c.chunk = row["id"].get<int64_t>();
        }
    };
    int max_candidates = std::clamp((offset + limit) * 8, 64, 4096);
    if (mode != "semantic") {
        std::string escaped;
        for (char c : query) { if (c == '%' || c == '_' || c == '\\') escaped += '\\'; escaped += c; }
        auto values = args;
        for (int i = 0; i < 4; ++i) values.push_back("%" + escaped + "%");
        values.push_back(query); values.push_back(query); values.push_back(max_candidates);
        channel(db.query("SELECT t.key thread_key FROM threads t LEFT JOIN projects p ON p.key=t.project_key WHERE " + filter +
            " AND (t.title LIKE ? ESCAPE '\\' OR t.cwd LIKE ? ESCAPE '\\' OR t.repo LIKE ? ESCAPE '\\' OR p.name LIKE ? ESCAPE '\\' OR t.thread_id=?) "
            "ORDER BY CASE WHEN t.thread_id=? THEN 0 ELSE 1 END,t.updated_at DESC,t.key LIMIT ?", values), .8, "metadata");
        // One-character searches stay in bounded metadata/recent paths.
        if (!fts.empty() && query.size() > 1) {
            int count = std::max(128, max_candidates);
            json rows;
            while (true) {
                values = json::array({fts}); for (const auto &v : args) values.push_back(v); values.push_back(count);
                rows = db.query("SELECT c.id,c.thread_key,chunks_fts.rank FROM chunks_fts "
                    "JOIN chunks c ON c.id=chunks_fts.rowid JOIN threads t ON t.key=c.thread_key "
                    "WHERE chunks_fts MATCH ? AND rank MATCH 'bm25(4,1)' AND " + filter + " ORDER BY chunks_fts.rank LIMIT ?", values);
                std::set<std::string> unique; for (auto &r : rows) unique.insert(str(r, "thread_key"));
                if (unique.size() >= static_cast<size_t>(offset + limit + 1) || rows.size() < static_cast<size_t>(count) || count >= 4096) break;
                count = std::min(count * 4, 4096);
            }
            channel(rows, 1, "keyword");
        }
    }
    double lexical_ms = elapsed(start) - inference_ms;
    auto vector_start = Clock::now();
    if (semantic) {
        int count = std::max(128, max_candidates);
        while (true) {
            auto values = json::array({count}); for (auto &v : args) values.push_back(v);
            // sqlite-vec 0.1.9 consumes rowid-IN as a KNN prefilter. Integration-tested with a disjoint source.
            auto knn_filter = filter == "1=1" ? "" : " AND v.chunk_id IN (SELECT c2.id FROM chunks c2 JOIN threads t ON t.key=c2.thread_key WHERE " + filter + ")";
            auto rows = db.vector_query("SELECT c.id,c.thread_key,v.distance FROM chunk_vectors v JOIN chunks c ON c.id=v.chunk_id "
                "WHERE v.embedding MATCH ? AND k=?" + knn_filter + " ORDER BY distance", vector, values);
            std::sort(rows.begin(),rows.end(),[](const json &a,const json &b){ return a["distance"]!=b["distance"] ? a["distance"]<b["distance"] : a["id"]<b["id"]; });
            std::set<std::string> unique; for (auto &r : rows) unique.insert(str(r, "thread_key"));
            if (unique.size() >= static_cast<size_t>(offset + limit + 1) || rows.size() < static_cast<size_t>(count) || count >= 4096) {
                channel(rows, 1, "semantic"); break;
            }
            count = std::min(count * 4, 4096);
        }
    }
    double vector_ms = elapsed(vector_start);
    std::vector<std::pair<std::string, Candidate>> ranked(candidates.begin(), candidates.end());
    std::sort(ranked.begin(), ranked.end(), [](const auto &a, const auto &b) {
        return a.second.score != b.second.score ? a.second.score > b.second.score : a.first < b.first;
    });
    json results = json::array(), selected = json::array(); std::string placeholders;
    for (size_t i = offset; i < ranked.size() && selected.size() < static_cast<size_t>(limit); ++i) {
        selected.push_back(ranked[i].first); placeholders += placeholders.empty() ? "?" : ",?";
    }
    std::map<std::string, json> hydrated;
    auto hydrate_args = json::array({query,query});
    for (auto &value : selected) hydrate_args.push_back(value);
    if (!selected.empty()) for (auto &row : db.query("SELECT t.*,p.name project_name,s.label source_label,i.origin_id,"
        "instr(lower(t.title),lower(?))>0 title_match,instr(lower(p.name),lower(?))>0 project_match FROM threads t "
        "LEFT JOIN projects p ON p.key=t.project_key LEFT JOIN sources s ON s.id=t.source_id "
        "LEFT JOIN source_identities i ON i.source_id=t.source_id WHERE t.key IN (" + placeholders + ")", hydrate_args)) hydrated[str(row,"key")] = row;
    for (const auto &selected_key : selected) {
        auto tk = selected_key.get<std::string>(); auto row = hydrated[tk]; auto &c = candidates[tk];
        c.title = !query.empty() && row.value("title_match",0) == 1;
        c.project = !query.empty() && !row["project_match"].is_null() && row["project_match"].get<int>() == 1;
        json evidence = json::object(), segments = json::array(); std::string snippet;
        if (c.chunk) {
            evidence = db.query("SELECT id,thread_key,item_id,turn_id,role,ordinal,byte_offset,text FROM chunks WHERE id=?", {c.chunk})[0];
            if (c.keyword && !fts.empty()) {
                // Random request-local markers cannot collide with stored text; retry if they ever do.
                auto marker = "SEARCH" + hash(tk + now() + std::to_string(Clock::now().time_since_epoch().count()));
                while (str(evidence,"text").find(marker) != std::string::npos || str(row,"title").find(marker) != std::string::npos) marker += "x";
                auto open = marker + "a", close = marker + "b";
                auto excerpts = db.query("SELECT snippet(chunks_fts,1,?,?,' … ',64) excerpt,highlight(chunks_fts,0,?,?) title_marked FROM chunks_fts WHERE chunks_fts MATCH ? AND rowid=?", {open, close, open, close, fts, c.chunk});
                if (!excerpts.empty()) {
                    c.title = c.title || str(excerpts[0],"title_marked").find(open) != std::string::npos;
                    auto text = str(excerpts[0], "excerpt"); size_t cursor = 0; bool matched = false;
                    while (cursor < text.size()) {
                        auto a = text.find(open, cursor), b = text.find(close, cursor);
                        auto end = std::min(a,b); if (end == std::string::npos) end = text.size();
                        if (end > cursor) segments.push_back({{"text",text.substr(cursor,end-cursor)},{"matched",matched}});
                        if (end == text.size()) break;
                        matched = end == a; cursor = end + (matched ? open.size() : close.size());
                    }
                    c.keyword = std::any_of(segments.begin(),segments.end(),[](const json &s){return s.value("matched",false);});
                    if (!c.keyword && c.semantic) {
                        c.chunk = c.semantic_chunk; segments = json::array();
                        evidence = db.query("SELECT id,thread_key,item_id,turn_id,role,ordinal,byte_offset,text FROM chunks WHERE id=?", {c.chunk})[0];
                    }
                    if (!c.keyword && !c.semantic) {
                        c.chunk = 0; segments = json::array({{{"text","Match in title or project"},{"matched",false}}});
                    }
                }
            }
            if (segments.empty()) {
                auto text = str(evidence,"text");
                if (text.size() > 700) text = split_text(text,700,0).front().second + " …";
                segments.push_back({{"text",text},{"matched",false}});
            }
            for (auto &s : segments) snippet += str(s,"text");
            evidence["keyword"] = c.keyword; evidence["metadata_match"] = c.metadata;
            evidence["title"] = c.title; evidence["project"] = c.project;
            evidence["semantic"] = c.semantic;
            if (c.semantic) evidence["similarity"] = c.similarity;
        } else if (!query.empty()) {
            snippet = "Match in title or project";
            segments.push_back({{"text",snippet},{"matched",false}});
        }
        auto nav = navigation(row);
        bool message_evidence = c.chunk && str(evidence, "role") != "metadata";
        auto display_title = str(row,"title");
        if (display_title.size()>512) display_title=split_text(display_title,512,0).front().second+" …";
        if (str(p,"presentation") == "palette-v1") {
            results.push_back({{"key",tk},{"sourceId",row["origin_id"]},{"threadId",row["thread_id"]},
                {"title",display_title},{"project",{{"id",row["project_key"]},{"name",row["project_name"]}}},
                {"sourceLabel",row["source_label"]},{"updatedAt",row["updated_at"]},
                {"snippet",{{"segments",segments},{"itemId",c.chunk ? evidence.value("item_id",json(nullptr)) : json(nullptr)},
                    {"turnId",message_evidence ? evidence.value("turn_id",json(nullptr)) : json(nullptr)},{"provenance",message_evidence ? "message" : "metadata"}}},
                {"navigation",nav}});
        } else {
            results.push_back({{"key",tk},{"source_id",row["source_id"]},{"origin_id",row["origin_id"]},
                {"source_label",row["source_label"]},{"thread_id",row["thread_id"]},{"title",display_title},
                {"project_key",row["project_key"]},{"project_name",row["project_name"]},{"repo",row["repo"]},
                {"branch",row["branch"]},{"archived",row["archived"]},{"updated_at",row["updated_at"]},
                {"url",str(nav,"url")},{"navigation",nav},{"snippet",snippet},{"score",c.score},
                {"matches",message_evidence ? json::array({evidence}) : json::array()},
                {"evidence",{{"title",c.title},{"project",c.project},{"keyword",c.keyword},{"semantic",c.semantic}}}});
        }
    }
    json result = {{"results",results},{"query",query},{"mode",semantic ? mode : "keyword"},
        {"warningCode",warning.empty() ? "" : "SEMANTIC_UNAVAILABLE"},{"corpusRevision",revision},{"warning",warning},
        {"candidate_threads",ranked.size()},{"has_more",ranked.size() > static_cast<size_t>(offset+limit)},
        {"offset",offset},{"timings",{{"total_ms",elapsed(start)},{"inference_ms",inference_ms},{"lexical_ms",lexical_ms},{"vector_ms",vector_ms}}}};
    if (warning.empty()) {
        std::lock_guard lock(cache_mutex);
        if (result_cache.size() >= 24) result_cache.erase(result_cache.begin());
        result_cache.emplace_back(cache_base + json(std::to_string(revision)).dump(), result);
    }
    return result;
}
} // namespace bettersearch
