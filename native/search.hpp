#pragma once
#include "json.hpp"
#include "sqlite3.h"
#include <atomic>
#include <chrono>
#include <array>
#include <condition_variable>
#include <filesystem>
#include <fstream>
#include <functional>
#include <map>
#include <memory>
#include <mutex>
#include <shared_mutex>
#include <optional>
#include <string>
#include <stdexcept>
#include <thread>
#include <vector>

namespace bettersearch {
using json = nlohmann::json;
namespace fs = std::filesystem;
struct ServiceFailure : std::runtime_error {
    std::string code;
    explicit ServiceFailure(std::string value) : std::runtime_error(value), code(std::move(value)) {}
};
inline std::string utf8(const fs::path &p) {
    auto s = p.u8string();
    return {s.begin(), s.end()};
}
inline std::string str(const json &j, const char *k, const std::string &fallback = "") {
    auto i = j.find(k);
    return i == j.end() || i->is_null() ? fallback
           : i->is_string()             ? i->get<std::string>()
                                        : i->dump();
}
std::string read_file(const fs::path &);
void write_file(const fs::path &, const std::string &);
std::string hash(const std::string &);
std::string now();
std::string clean_text(std::string);
std::vector<std::pair<size_t, std::string>> split_text(const std::string &, size_t size = 2400,
                                                       size_t overlap = 180);
std::string normalize_origin(std::string);
void each_rollout_line(const fs::path &, const std::function<bool(const std::string &, int64_t)> &);

class Db {
  public:
    enum class Role { SearchWriter, SearchReadOnly, CodexSourceReadOnly };
    sqlite3 *handle = nullptr;
    explicit Db(const fs::path &, Role role = Role::SearchWriter);
    Db(const fs::path &p, bool readonly) : Db(p, readonly ? Role::CodexSourceReadOnly : Role::SearchWriter) {}
    ~Db();
    Db(const Db &) = delete;
    Db &operator=(const Db &) = delete;
    void exec(const std::string &);
    json query(const std::string &, const json &params = json::array());
    void run(const std::string &, const json &params = json::array());
    void blob(const std::string &, int64_t id, const std::vector<float> &);
    json vector_query(const std::string &, const std::vector<float> &, const json &);
    void backup(const fs::path &);
};
struct SourceData {
    std::map<std::string, json> threads, projects;
    std::vector<std::string> warnings;
    fs::path history;
};
SourceData scan_source(const json &);
json read_messages(const json &, Db *);
struct Inference;
struct SearchSession {
    int64_t latest = 0;
    bool running = false;
};
struct UpdateSchedule {
    using Clock = std::chrono::steady_clock;
    static constexpr auto interval = std::chrono::minutes(15);
    Clock::time_point next = Clock::now();
    bool due(Clock::time_point now, bool enabled, bool busy) const {
        return enabled && !busy && now >= next;
    }
    void defer(Clock::time_point now = Clock::now()) { next = now + interval; }
};
class Engine {
  public:
    fs::path home;
    json config;
    std::recursive_mutex mutex;
    std::mutex inference_mutex, query_inference_mutex, query_execution_mutex;
    std::mutex performance_mutex;
    json performance = {{"read_ms", 0.0},  {"tokenize_ms", 0.0}, {"model_ms", 0.0},
                        {"write_ms", 0.0}, {"batches", 0},       {"documents", 0},
                        {"tokens", 0}};
    std::shared_ptr<Inference> index_inference, query_inference;
    std::array<std::unique_ptr<Db>, 3> readers;
    std::array<bool, 3> reader_busy{};
    std::mutex reader_mutex, session_mutex, cache_mutex;
    std::shared_mutex maintenance_mutex;
    std::condition_variable reader_available, session_available;
    std::map<std::string, std::shared_ptr<SearchSession>> sessions;
    std::vector<std::pair<std::string, std::vector<float>>> query_cache;
    std::vector<std::pair<std::string, json>> result_cache;
    struct SearchSnapshot { std::string id, owner, query; json result; std::chrono::steady_clock::time_point created; };
    std::vector<SearchSnapshot> search_snapshots;
    std::atomic<bool> indexing = false, embedding = false, stopping = false;
    std::atomic<bool> paused = false, automatic_updates = true, model_installing = false, embedding_pending = false;
    bool index_pending = false;
    UpdateSchedule update_schedule;
    std::string embedding_error;
    std::atomic<int> resource_profile = 1;
    json preferences;
    std::thread index_thread, embed_thread, watch_thread, model_thread;
    json progress = {{"phase", "idle"}, {"done", 0}, {"total", 0}, {"error", nullptr}};
    explicit Engine(fs::path home);
    ~Engine();
    void init();
    json status();
    json tree();
    json search(const json &);
    json search_impl(const json &);
    json navigation(const json &);
    void init_preferences();
    json read_settings();
    json update_settings(const json &);
    json settings_action(const json &);
    json diagnostics();
    json dispatch(const std::string &, const json &);
    json start_index(bool automatic = false);
    json start_embeddings(bool retry = true);
    void background_tick();
    void index();
    void embed();
    std::vector<std::vector<float>> encode(const std::vector<std::string> &, bool query = false);
    fs::path db_path() const {
        return home / "search.sqlite";
    }
};
// A connection is exclusively leased, never shared between concurrent requests.
class ReaderLease {
    Engine &engine;
    size_t slot;
  public:
    explicit ReaderLease(Engine &);
    ~ReaderLease();
    Db &db() { return *engine.readers[slot]; }
};
} // namespace bettersearch
