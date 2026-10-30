#ifndef SQLITE_CORE
#define SQLITE_CORE
#endif
#ifndef SQLITE_VEC_STATIC
#define SQLITE_VEC_STATIC
#endif
#include "search.hpp"
#include "sqlite-vec.h"
#include <chrono>
#include <algorithm>
#include <iomanip>
#include <regex>
#include <set>
#include <sstream>
#include <stdexcept>

namespace bettersearch {
static fs::path default_model_path() {
    auto env_path = [](const char *name) {
        auto value = std::getenv(name);
        return value && *value ? fs::u8path(value) : fs::path{};
    };
    auto cache = env_path("HF_HUB_CACHE");
    if (cache.empty()) cache = env_path("HUGGINGFACE_HUB_CACHE");
    if (cache.empty()) {
        auto hf = env_path("HF_HOME");
        if (hf.empty()) {
            auto root = env_path("XDG_CACHE_HOME");
            if (root.empty()) {
                root = env_path("USERPROFILE");
                if (root.empty()) root = env_path("HOME");
                root /= ".cache";
            }
            hf = root / "huggingface";
        }
        cache = hf / "hub";
    }
    return fs::absolute(cache / "models--ggml-org--embeddinggemma-2-GGUF" / "snapshots" /
                        "58faf90940886df2d62be555c8765d00dac362c5" / "embeddinggemma-2-BF16.gguf");
}
std::string read_file(const fs::path &p) {
    std::ifstream f(p, std::ios::binary);
    if (!f)
        throw std::runtime_error("Cannot read " + utf8(p));
    return {std::istreambuf_iterator<char>(f), {}};
}
void write_file(const fs::path &p, const std::string &s) {
    fs::create_directories(p.parent_path());
    std::ofstream f(p, std::ios::binary);
    f << s;
    if (!f)
        throw std::runtime_error("Cannot write " + utf8(p));
}
std::string hash(const std::string &s) {
    uint64_t a = 14695981039346656037ULL, b = 1099511628211ULL;
    for (unsigned char c : s) {
        a = (a ^ c) * 1099511628211ULL;
        b = (b + c) * 0x9e3779b185ebca87ULL;
        b ^= b >> 29;
    }
    std::ostringstream o;
    o << std::hex << a << b;
    return o.str();
}
std::string now() {
    auto t = std::chrono::system_clock::to_time_t(std::chrono::system_clock::now());
    std::tm v{};
#ifdef _WIN32
    gmtime_s(&v, &t);
#else
    gmtime_r(&t, &v);
#endif
    std::ostringstream o;
    o << std::put_time(&v, "%Y-%m-%dT%H:%M:%SZ");
    return o.str();
}
std::string clean_text(std::string s) {
    for (auto tag : {"environment_context", "external_codex_apps_open_page"}) {
        std::string open = "<" + std::string(tag) + ">", close = "</" + std::string(tag) + ">";
        size_t a;
        while ((a = s.find(open)) != std::string::npos) {
            auto b = s.find(close, a);
            if (b == std::string::npos)
                break;
            s.erase(a, b + close.size() - a);
        }
    }
    auto a = s.find_first_not_of(" \r\n\t");
    if (a == std::string::npos)
        return "";
    return s.substr(a, s.find_last_not_of(" \r\n\t") - a + 1);
}
std::vector<std::pair<size_t, std::string>> split_text(const std::string &s, size_t size,
                                                       size_t overlap) {
    std::vector<std::pair<size_t, std::string>> r;
    for (size_t start = 0; start < s.size();) {
        auto end = std::min(start + size, s.size());
        if (end < s.size()) {
            auto b = s.rfind('\n', end);
            if (b != std::string::npos && b > start + size / 2)
                end = b + 1;
            while (end < s.size() && (static_cast<unsigned char>(s[end]) & 0xc0) == 0x80)
                --end;
        }
        r.emplace_back(start, s.substr(start, end - start));
        if (end == s.size())
            break;
        start = std::max(start + 1, end - overlap);
        while (start < s.size() && (static_cast<unsigned char>(s[start]) & 0xc0) == 0x80)
            ++start;
    }
    return r;
}
std::string normalize_origin(std::string s) {
    auto scheme = s.find("://");
    if (scheme != std::string::npos) {
        s = s.substr(scheme + 3);
        auto slash = s.find('/'), at = s.find('@');
        if (at != std::string::npos && (slash == std::string::npos || at < slash))
            s = s.substr(at + 1);
        auto query = s.find_first_of("?#");
        if (query != std::string::npos)
            s.resize(query);
    } else if (auto at = s.find('@'); at != std::string::npos) {
        s = s.substr(at + 1);
        auto colon = s.find(':');
        if (colon != std::string::npos)
            s[colon] = '/';
    }
    while (!s.empty() && s.back() == '/')
        s.pop_back();
    if (s.ends_with(".git"))
        s.resize(s.size() - 4);
    return s;
}
Db::Db(const fs::path &p, Role role) {
    bool ro = role != Role::SearchWriter;
    int flags = ro ? SQLITE_OPEN_READONLY : SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE;
    int rc = sqlite3_open_v2(utf8(p).c_str(), &handle, flags | SQLITE_OPEN_FULLMUTEX, nullptr);
    if (rc != SQLITE_OK) {
        std::string msg = handle ? sqlite3_errmsg(handle) : "open failed";
        if (handle)
            sqlite3_close(handle);
        handle = nullptr;
        throw std::runtime_error(msg + ": " + utf8(p));
    }
    sqlite3_busy_timeout(handle, 10000);
    if (ro) {
        exec("PRAGMA query_only=ON");
    }
    if (role != Role::CodexSourceReadOnly) {
        char *err = nullptr;
        if (sqlite3_vec_init(handle, &err, nullptr) != SQLITE_OK) {
            std::string msg = err ? err : "sqlite-vec init failed";
            sqlite3_free(err);
            throw std::runtime_error(msg);
        }
        exec("PRAGMA foreign_keys=ON");
        exec("PRAGMA cache_size=-16384");
        exec("PRAGMA mmap_size=536870912");
    }
}
Db::~Db() {
    if (handle)
        sqlite3_close(handle);
}
void Db::exec(const std::string &sql) {
    char *e = nullptr;
    if (sqlite3_exec(handle, sql.c_str(), nullptr, nullptr, &e) != SQLITE_OK) {
        std::string s = e ? e : sqlite3_errmsg(handle);
        sqlite3_free(e);
        throw std::runtime_error(s);
    }
}
static void bind_values(sqlite3_stmt *s, const json &values) {
    int i = 1;
    for (const auto &v : values) {
        if (v.is_null())
            sqlite3_bind_null(s, i);
        else if (v.is_boolean())
            sqlite3_bind_int(s, i, v.get<bool>() ? 1 : 0);
        else if (v.is_number_integer())
            sqlite3_bind_int64(s, i, v.get<int64_t>());
        else if (v.is_number_float())
            sqlite3_bind_double(s, i, v.get<double>());
        else {
            auto t = v.is_string() ? v.get<std::string>() : v.dump();
            sqlite3_bind_text(s, i, t.c_str(), static_cast<int>(t.size()), SQLITE_TRANSIENT);
        }
        ++i;
    }
}
static json rows(sqlite3 *handle, sqlite3_stmt *raw) {
    json result = json::array();
    int rc;
    while ((rc = sqlite3_step(raw)) == SQLITE_ROW) {
        json row = json::object();
        for (int i = 0; i < sqlite3_column_count(raw); ++i) {
            auto key = sqlite3_column_name(raw, i);
            switch (sqlite3_column_type(raw, i)) {
            case SQLITE_NULL:
                row[key] = nullptr;
                break;
            case SQLITE_INTEGER:
                row[key] = sqlite3_column_int64(raw, i);
                break;
            case SQLITE_FLOAT:
                row[key] = sqlite3_column_double(raw, i);
                break;
            case SQLITE_BLOB:
                row[key] = "[binary]";
                break;
            default:
                row[key] = std::string(reinterpret_cast<const char *>(sqlite3_column_text(raw, i)),
                                       sqlite3_column_bytes(raw, i));
            }
        }
        result.push_back(std::move(row));
    }
    if (rc != SQLITE_DONE)
        throw std::runtime_error(sqlite3_errmsg(handle));
    return result;
}
json Db::query(const std::string &sql, const json &values) {
    sqlite3_stmt *raw = nullptr;
    if (sqlite3_prepare_v2(handle, sql.c_str(), -1, &raw, nullptr) != SQLITE_OK)
        throw std::runtime_error(sqlite3_errmsg(handle));
    std::unique_ptr<sqlite3_stmt, decltype(&sqlite3_finalize)> stmt(raw, sqlite3_finalize);
    bind_values(raw, values);
    return rows(handle, raw);
}
json Db::vector_query(const std::string &sql, const std::vector<float> &v, const json &values) {
    sqlite3_stmt *raw = nullptr;
    if (sqlite3_prepare_v2(handle, sql.c_str(), -1, &raw, nullptr) != SQLITE_OK)
        throw std::runtime_error(sqlite3_errmsg(handle));
    std::unique_ptr<sqlite3_stmt, decltype(&sqlite3_finalize)> stmt(raw, sqlite3_finalize);
    auto args = json::array({nullptr});
    for (const auto &value : values) args.push_back(value);
    bind_values(raw, args);
    sqlite3_bind_blob(raw, 1, v.data(), static_cast<int>(v.size() * sizeof(float)), SQLITE_TRANSIENT);
    return rows(handle, raw);
}
void Db::backup(const fs::path &path) {
    fs::create_directories(path.parent_path());
    sqlite3 *target = nullptr;
    if (sqlite3_open(utf8(path).c_str(), &target) != SQLITE_OK) {
        if (target) sqlite3_close(target);
        throw std::runtime_error("Cannot open index backup");
    }
    auto *copy = sqlite3_backup_init(target, "main", handle, "main");
    int rc = copy ? sqlite3_backup_step(copy, -1) : SQLITE_ERROR;
    if (copy) sqlite3_backup_finish(copy);
    sqlite3_close(target);
    if (rc != SQLITE_DONE) throw std::runtime_error("Consistent index backup failed");
}
ReaderLease::ReaderLease(Engine &e) : engine(e) {
    std::unique_lock lock(engine.reader_mutex);
    engine.reader_available.wait(lock, [&] {
        return std::find(engine.reader_busy.begin(), engine.reader_busy.end(), false) != engine.reader_busy.end();
    });
    slot = std::find(engine.reader_busy.begin(), engine.reader_busy.end(), false) - engine.reader_busy.begin();
    engine.reader_busy[slot] = true;
}
ReaderLease::~ReaderLease() {
    { std::lock_guard lock(engine.reader_mutex); engine.reader_busy[slot] = false; }
    engine.reader_available.notify_one();
}
void Db::run(const std::string &s, const json &p) {
    query(s, p);
}
void Db::blob(const std::string &sql, int64_t id, const std::vector<float> &v) {
    sqlite3_stmt *raw = nullptr;
    if (sqlite3_prepare_v2(handle, sql.c_str(), -1, &raw, nullptr) != SQLITE_OK)
        throw std::runtime_error(sqlite3_errmsg(handle));
    std::unique_ptr<sqlite3_stmt, decltype(&sqlite3_finalize)> stmt(raw, sqlite3_finalize);
    sqlite3_bind_int64(raw, 1, id);
    sqlite3_bind_blob(raw, 2, v.data(), static_cast<int>(v.size() * sizeof(float)),
                      SQLITE_TRANSIENT);
    if (sqlite3_step(raw) != SQLITE_DONE)
        throw std::runtime_error(sqlite3_errmsg(handle));
}
Engine::Engine(fs::path p) : home(std::move(p)) {}
Engine::~Engine() {
    stopping = true;
    if (watch_thread.joinable())
        watch_thread.join();
    if (index_thread.joinable())
        index_thread.join();
    if (embed_thread.joinable())
        embed_thread.join();
    if (model_thread.joinable())
        model_thread.join();
}
void Engine::init() {
    fs::create_directories(home);
    init_preferences();
    auto cp = home / "config.json";
    if (fs::exists(cp))
        config = json::parse(read_file(cp));
    else {
        auto env = std::getenv("CODEX_HOME");
        auto user = std::getenv("USERPROFILE");
        if (!user)
            user = std::getenv("HOME");
        auto root = env ? fs::u8path(env) : fs::u8path(user ? user : ".") / ".codex";
        config = {
            {"version", 1},
            {"model", "google/embeddinggemma-2"},
            {"model_file", utf8(default_model_path())},
            {"model_sha256", "68bae29d62fb8c7d23e98d21fd4662753ddd636e6b62b8a70dfe059a9844f216"},
            {"dimensions", 768},
            {"sources",
             json::array(
                 {{{"id", "local"},
                   {"label", std::getenv("COMPUTERNAME") ? std::getenv("COMPUTERNAME") : "Local"},
                   {"kind", "local"},
                   {"codex_home", utf8(root)}}})}};
        write_file(cp, config.dump(2));
    }
    if (config.value("dimensions", 768) != 768 || str(config, "model") != "google/embeddinggemma-2")
        throw std::runtime_error("This index requires EmbeddingGemma 2 with 768 dimensions");
    std::set<std::string> source_ids;
    for (const auto &source : config.at("sources")) {
        auto id = str(source, "id");
        if (!std::regex_match(id, std::regex("[A-Za-z0-9_-]{1,100}")) ||
            !source_ids.insert(id).second)
            throw std::runtime_error(
                "Source IDs must be unique letters, numbers, underscores or hyphens");
    }
    Db db(db_path());
    auto schema = db.query("PRAGMA user_version")[0]["user_version"].get<int>();
    if (schema != 0 && schema != 1)
        throw std::runtime_error("Unsupported index schema. Use a fresh BETTER_SEARCH_HOME.");
    db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;");
    db.exec("BEGIN IMMEDIATE");
    try {
    db.exec(R"SQL(
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sources(id TEXT PRIMARY KEY,label TEXT NOT NULL,root TEXT NOT NULL,kind TEXT NOT NULL,last_sync TEXT,warnings TEXT);
CREATE TABLE IF NOT EXISTS projects(key TEXT PRIMARY KEY,source_id TEXT NOT NULL,name TEXT NOT NULL,path TEXT,repo TEXT);
CREATE TABLE IF NOT EXISTS threads(key TEXT PRIMARY KEY,source_id TEXT NOT NULL,thread_id TEXT NOT NULL,title TEXT NOT NULL,cwd TEXT,project_key TEXT,repo TEXT,branch TEXT,archived INTEGER NOT NULL DEFAULT 0,created_at TEXT,updated_at TEXT,signature TEXT,content_available INTEGER NOT NULL DEFAULT 0,metadata TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS thread_project ON threads(project_key);
CREATE INDEX IF NOT EXISTS thread_source ON threads(source_id);
CREATE TABLE IF NOT EXISTS chunks(id INTEGER PRIMARY KEY,thread_key TEXT NOT NULL REFERENCES threads(key) ON DELETE CASCADE,item_id TEXT,turn_id TEXT,role TEXT,ordinal INTEGER,byte_offset INTEGER,title TEXT NOT NULL,text TEXT NOT NULL,digest TEXT NOT NULL,embedded INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS chunk_thread ON chunks(thread_key);
CREATE INDEX IF NOT EXISTS chunk_pending ON chunks(embedded,id);
CREATE INDEX IF NOT EXISTS chunk_digest ON chunks(digest);
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(title,text,content='chunks',content_rowid='id',tokenize='unicode61 remove_diacritics 2');
CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN INSERT INTO chunks_fts(rowid,title,text) VALUES(new.id,new.title,new.text); END;
CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN INSERT INTO chunks_fts(chunks_fts,rowid,title,text) VALUES('delete',old.id,old.title,old.text); END;
CREATE VIRTUAL TABLE IF NOT EXISTS chunk_vectors USING vec0(chunk_id INTEGER PRIMARY KEY,embedding float[768] distance_metric=cosine);
)SQL");
    db.exec("CREATE TABLE IF NOT EXISTS source_identities(source_id TEXT PRIMARY KEY,origin_id TEXT NOT NULL UNIQUE)");
    db.exec("INSERT OR IGNORE INTO settings VALUES('corpus_revision','0')");
    db.exec("PRAGMA user_version=1");
    db.exec("COMMIT");
    } catch (...) { db.exec("ROLLBACK"); throw; }
    auto fingerprint = config.at("model_sha256").get<std::string>() + ":768:search-prefix-v1:title512-v1";
    auto prev = db.query("SELECT value FROM settings WHERE key='embedding_fingerprint'");
    if (!prev.empty() && prev[0]["value"] != fingerprint)
        throw std::runtime_error("Embedding model changed. Use a new BETTER_SEARCH_HOME or rebuild "
                                 "the index; mixing vector spaces is forbidden.");
    db.run("INSERT OR IGNORE INTO settings VALUES('embedding_fingerprint',?)", {fingerprint});
    for (const auto &s : config["sources"]) {
        db.run("INSERT INTO sources(id,label,root,kind) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE "
               "SET label=excluded.label,root=excluded.root,kind=excluded.kind WHERE sources.label IS NOT excluded.label OR sources.root IS NOT excluded.root OR sources.kind IS NOT excluded.kind",
               {s["id"], s["label"], s["codex_home"], s.value("kind", "local")});
        if (sqlite3_changes(db.handle))
            db.exec("UPDATE settings SET value=CAST(value AS INTEGER)+1 WHERE key='corpus_revision'");
        db.run("INSERT OR IGNORE INTO source_identities(source_id,origin_id) VALUES(?,lower(hex(randomblob(16))))", {s["id"]});
    }
    for (auto &reader : readers) reader = std::make_unique<Db>(db_path(), Db::Role::SearchReadOnly);
}
} // namespace bettersearch
