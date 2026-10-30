#include "search.hpp"
#include "httplib.h"
#include <cmath>
#include <csignal>
#include <iostream>
#ifdef _WIN32
#include <process.h>
#else
#include <unistd.h>
#endif

namespace {
httplib::Server *active_server = nullptr;
void stop_handler(int) {
    if (active_server)
        active_server->stop();
}
} // namespace
int main(int argc, char **argv) {
    using namespace bettersearch;
    try {
        std::map<std::string, std::string> args;
        for (int i = 1; i < argc; ++i) {
            std::string a = argv[i];
            if (a.starts_with("--")) {
                args[a] = (i + 1 < argc && !std::string(argv[i + 1]).starts_with("--")) ? argv[++i]
                                                                                        : "true";
            }
        }
        if (args.contains("--index-check")) {
            if (!args.contains("--database")) throw std::runtime_error("--database is required for an index check");
            Db database(fs::u8path(args["--database"]), Db::Role::SearchReadOnly);
            auto signature = [&](const std::string &sql) {
                sqlite3_stmt *raw = nullptr;
                if (sqlite3_prepare_v2(database.handle, sql.c_str(), -1, &raw, nullptr) != SQLITE_OK)
                    throw std::runtime_error(sqlite3_errmsg(database.handle));
                std::unique_ptr<sqlite3_stmt, decltype(&sqlite3_finalize)> statement(raw, sqlite3_finalize);
                std::string digest;
                int64_t count = 0;
                int rc;
                while ((rc = sqlite3_step(raw)) == SQLITE_ROW) {
                    for (int column = 0; column < sqlite3_column_count(raw); ++column) {
                        auto *bytes = static_cast<const char *>(sqlite3_column_blob(raw, column));
                        auto length = sqlite3_column_bytes(raw, column);
                        digest = hash(digest + std::to_string(length) + ":" + (bytes ? std::string(bytes, length) : ""));
                    }
                    ++count;
                }
                if (rc != SQLITE_DONE) throw std::runtime_error(sqlite3_errmsg(database.handle));
                return json{{"rows", count}, {"signature", digest}};
            };
            std::cout << json({{"chunks", signature("SELECT id,thread_key,item_id,turn_id,role,ordinal,byte_offset,title,text,digest,embedded FROM chunks ORDER BY id")},
                {"vectors", signature("SELECT chunk_id,embedding FROM chunk_vectors ORDER BY chunk_id")},
                {"fingerprint", database.query("SELECT value FROM settings WHERE key='embedding_fingerprint'")}}).dump() << '\n';
            return 0;
        }
        if (args.contains("--build-info")) {
            std::cout << json({{"version", BETTER_SEARCH_VERSION}, {"profile", BETTER_SEARCH_BUILD_PROFILE},
                {"portable_cpu", bool(BETTER_SEARCH_PORTABLE_CPU)}}).dump() << '\n';
            return 0;
        }
        if (args.contains("--self-test")) {
            auto require = [](bool ok) {
                if (!ok)
                    throw std::runtime_error("Native self-test failed");
            };
            auto s = std::string("Hallo äöü 🌱\n") + std::string(10000, 'x');
            auto chunks = split_text(s);
            for (const auto &[off, text] : chunks) {
                require(s.substr(off, text.size()) == text);
                json j = text;
                require(json::parse(j.dump()) == j);
            }
            require(clean_text("<environment_context>secret</environment_context> hello") ==
                    "hello");
            require(normalize_origin("https://token@example.org/team/repo.git") ==
                    "example.org/team/repo");
            UpdateSchedule schedule;
            auto instant = UpdateSchedule::Clock::time_point{};
            schedule.defer(instant);
            require(!schedule.due(instant + std::chrono::minutes(1), true, false));
            require(!schedule.due(instant + std::chrono::minutes(15) - std::chrono::seconds(1), true, false));
            require(schedule.due(instant + std::chrono::minutes(15), true, false));
            require(!schedule.due(instant + std::chrono::minutes(20), false, false));
            require(!schedule.due(instant + std::chrono::minutes(20), true, true));
            schedule.defer(instant + std::chrono::minutes(20));
            require(!schedule.due(instant + std::chrono::minutes(34), true, false));
            require(schedule.due(instant + std::chrono::minutes(35), true, false));
            Engine guarded(fs::path{});
            guarded.embedding = true;
            require(!guarded.start_index(true)["started"].get<bool>() && !guarded.index_pending);
            require(!guarded.start_index()["started"].get<bool>() && guarded.index_pending);
            guarded.embedding = false; guarded.indexing = true;
            require(!guarded.start_embeddings()["started"].get<bool>());
            guarded.indexing = false; guarded.paused = true;
            require(!guarded.start_index()["started"].get<bool>());
            guarded.paused = false; guarded.index_pending = false; guarded.model_installing = true;
            require(!guarded.start_index()["started"].get<bool>() && guarded.index_pending);
            Db vectors(fs::path(":memory:"));
            vectors.exec("CREATE VIRTUAL TABLE test_vectors USING vec0(chunk_id INTEGER PRIMARY KEY,embedding float[2] distance_metric=cosine)");
            for (int i=1;i<=256;++i) vectors.blob("INSERT INTO test_vectors VALUES(?,?)",i,{1,0});
            vectors.blob("INSERT INTO test_vectors VALUES(?,?)",257,{0,1});
            auto filtered=vectors.vector_query("SELECT chunk_id,distance FROM test_vectors WHERE embedding MATCH ? AND k=? AND chunk_id IN (SELECT chunk_id FROM test_vectors WHERE chunk_id>=257) ORDER BY distance",{1,0},{1});
            if (filtered.size()!=1 || filtered[0]["chunk_id"]!=257)
                throw std::runtime_error("sqlite-vec KNN subquery prefilter failed: " + filtered.dump());
            std::cout << "native self-test passed\n";
            return 0;
        }
        fs::path home = args.contains("--data") ? fs::u8path(args["--data"]) : default_data_home();
        Engine engine(home);
        engine.init();
        if (args.contains("--benchmark-query")) {
            std::vector<std::string> queries = {"OAuth Login", "SQLite Migration", "Projekt umbenennen",
                "find conversations about secure authentication", "C++ native EmbeddingGemma",
                "Wo wurde die Suchpalette besprochen?", "session_id", "src/ui.ts", "Umlaute äöü 🌱"};
            auto timer = std::chrono::steady_clock::now();
            engine.encode({"warmup"}, true);
            double cold = std::chrono::duration<double,std::milli>(std::chrono::steady_clock::now()-timer).count();
            json report = {{"profile","cpu-only"},{"cold_ms",cold},{"threads",std::getenv("BETTER_SEARCH_QUERY_THREADS") ? std::getenv("BETTER_SEARCH_QUERY_THREADS") : "8"}, {"samples",json::array()}};
            for (const auto &query : queries) {
                timer = std::chrono::steady_clock::now();
                auto v = engine.encode({query}, true).front();
                double ms = std::chrono::duration<double,std::milli>(std::chrono::steady_clock::now()-timer).count();
                double norm = 0; for (float f : v) norm += f*f;
                json sample = {{"query",query},{"ms",ms},{"norm",norm}};
                if (args.contains("--compare-gpu")) {
                    auto reference = engine.encode({"task: search result | query: " + query}).front();
                    double cosine = 0; for (size_t i=0;i<v.size();++i) cosine += v[i]*reference[i];
                    Db db(engine.db_path(), Db::Role::SearchReadOnly);
                    auto top = [&](const std::vector<float> &values) {
                        auto rows = db.vector_query("SELECT c.thread_key FROM chunk_vectors v JOIN chunks c ON c.id=v.chunk_id WHERE v.embedding MATCH ? AND k=? ORDER BY distance",values,{256});
                        std::vector<std::string> keys;
                        for (auto &row : rows) { auto key=str(row,"thread_key"); if(std::find(keys.begin(),keys.end(),key)==keys.end()) keys.push_back(key); if(keys.size()==10) break; }
                        return keys;
                    };
                    auto a = top(v), b = top(reference); size_t overlap = 0;
                    for (auto &key : a) if (std::find(b.begin(),b.end(),key)!=b.end()) ++overlap;
                    sample["cpu_gpu_cosine"] = cosine;
                    sample["top10_overlap"] = a.empty() ? 1.0 : double(overlap)/a.size();
                }
                report["samples"].push_back(sample);
            }
            report["performance"] = engine.performance;
            std::cout << report.dump() << '\n'; return 0;
        }
        if (args.contains("--benchmark")) {
            Db db(engine.db_path());
            int count =
                args.contains("--count") ? std::clamp(std::stoi(args["--count"]), 1, 2048) : 128;
            auto rows = db.query(
                "SELECT title,text FROM chunks WHERE embedded=0 ORDER BY id LIMIT ?", {count});
            if (rows.empty())
                rows = db.query("SELECT title,text FROM chunks ORDER BY id LIMIT ?", {count});
            std::vector<std::string> inputs;
            for (const auto &r : rows) {
                auto title = str(r, "title");
                if (title.size() > 512)
                    title = split_text(title, 512, 0).front().second;
                inputs.push_back("title: " + title + " | text: " + str(r, "text"));
            }
            engine.encode({inputs.front()}); // Warm up model and CUDA kernels.
            {
                std::lock_guard lock(engine.performance_mutex);
                engine.performance = {{"read_ms", 0.0},  {"tokenize_ms", 0.0}, {"model_ms", 0.0},
                                      {"write_ms", 0.0}, {"batches", 0},       {"documents", 0},
                                      {"tokens", 0}};
            }
            auto start = std::chrono::steady_clock::now();
            auto output = engine.encode(inputs);
            auto seconds =
                std::chrono::duration<double>(std::chrono::steady_clock::now() - start).count();
            json report = {{"seconds", seconds},
                           {"documents_per_second", inputs.size() / seconds},
                           {"performance", engine.performance}};
            if (args.contains("--verify-serial")) {
                double minimum = 1;
                for (size_t offset = 0; offset < inputs.size(); offset += 4) {
                    auto end = std::min(offset + 4, inputs.size());
                    auto reference = engine.encode(
                        std::vector<std::string>(inputs.begin() + offset, inputs.begin() + end));
                    for (size_t i = 0; i < reference.size(); ++i) {
                        double cosine = 0;
                        for (size_t j = 0; j < 768; ++j)
                            cosine += reference[i][j] * output[offset + i][j];
                        minimum = std::min(minimum, cosine);
                    }
                }
                if (minimum < 0.99999)
                    throw std::runtime_error("Parallel embedding consistency check failed");
                report["min_serial_cosine"] = minimum;
            }
            std::cout << report.dump() << '\n';
            return 0;
        }
        if (args.contains("--index-only")) {
            engine.index();
            std::cout << engine.status().dump() << '\n';
            return 0;
        }
        if (args.contains("--status")) {
            std::cout << engine.status().dump() << '\n';
            return 0;
        }
        if (args.contains("--embed-only")) {
            engine.embed();
            std::cout << engine.status().dump() << '\n';
            return 0;
        }
        if (!args.contains("--token-file"))
            throw std::runtime_error("--token-file is required for the local service");
        auto token = read_file(fs::u8path(args["--token-file"]));
        if (token.size() < 32)
            throw std::runtime_error("Invalid local access token");
        int port = args.contains("--port") ? std::stoi(args["--port"]) : 39470;
        if (port < 1024 || port > 65535)
            throw std::runtime_error("Invalid port");
        httplib::Server server;
        active_server = &server;
        std::signal(SIGINT, stop_handler);
        std::signal(SIGTERM, stop_handler);
        server.set_payload_max_length(65536);
        server.new_task_queue = [] { return new httplib::ThreadPool(6); };
        auto local_host = [port](const httplib::Request &req) {
            auto h = req.get_header_value("Host");
            return h == "127.0.0.1:" + std::to_string(port) ||
                   h == "localhost:" + std::to_string(port);
        };
        server.Get("/health", [&](const auto &req, auto &res) {
            if (!local_host(req)) {
                res.status = 403;
                return;
            }
            res.set_content(json({{"service", "better-search"}, {"version", BETTER_SEARCH_VERSION}}).dump(),
                            "application/json");
        });
        server.Post("/api", [&](const auto &req, auto &res) {
            res.set_header("Cache-Control", "no-store");
            auto origin = req.get_header_value("Origin");
            auto allowed = "http://127.0.0.1:" + std::to_string(port);
            if (!local_host(req) ||
                (!origin.empty() && origin != allowed &&
                 origin != "http://localhost:" + std::to_string(port)) ||
                req.get_header_value("Authorization") != "Bearer " + token ||
                !req.get_header_value("Content-Type").starts_with("application/json")) {
                res.status = 403;
                res.set_content("{\"error\":\"Forbidden\"}", "application/json");
                return;
            }
            try {
                auto p = json::parse(req.body);
                if (str(p, "method") == "shutdown") {
                    res.set_content("{\"result\":{\"stopping\":true}}", "application/json");
                    engine.stopping = true; server.stop(); return;
                }
                auto result = engine.dispatch(p.at("method").template get<std::string>(),
                                              p.value("params", json::object()));
                res.set_content(json({{"result", result}}).dump(), "application/json");
            } catch (const ServiceFailure &e) {
                res.status = 400;
                res.set_content(json({{"error", e.code}, {"code", e.code}}).dump(), "application/json");
            } catch (const std::exception &e) {
                res.status = 400;
                res.set_content(json({{"error", e.what()}, {"code", "REQUEST_FAILED"}}).dump(), "application/json");
            }
        });
        if (!server.bind_to_port("127.0.0.1", port))
            throw std::runtime_error("Cannot bind local service port");
#ifdef _WIN32
        write_file(home / "service.pid", std::to_string(_getpid()));
#else
        write_file(home / "service.pid", std::to_string(getpid()));
#endif
        if (!args.contains("--no-watch")) {
            engine.background_tick();
            engine.watch_thread = std::thread([&] {
                while (!engine.stopping) {
                    std::this_thread::sleep_for(std::chrono::seconds(1));
                    if (engine.stopping)
                        break;
                    engine.background_tick();
                }
            });
        }
        std::cerr << "BetterSearch listening locally on 127.0.0.1:" << port << '\n';
        bool ok = server.listen_after_bind();
        engine.stopping = true;
        active_server = nullptr;
        if (!ok)
            throw std::runtime_error("Cannot bind local service port");
        return 0;
    } catch (const std::exception &e) {
        std::cerr << "BetterSearch: " << e.what() << '\n';
        return 1;
    }
}
