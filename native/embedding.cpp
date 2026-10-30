#include "search.hpp"
#include "ggml-backend.h"
#include "llama.h"
#include <algorithm>
#include <cmath>
#include <condition_variable>
#include <cstdio>

namespace bettersearch {
struct Inference {
    llama_model *model = nullptr;
    std::vector<llama_context *> contexts;
    std::vector<bool> busy;
    std::mutex pool_mutex;
    std::condition_variable available;
    int waiting_queries = 0;
    bool accelerated = false;
    explicit Inference(const fs::path &path, bool query, bool force_cpu = false) {
        static std::once_flag initialized;
        std::call_once(initialized, [] {
            llama_log_set(
                [](ggml_log_level level, const char *text, void *) {
                    if (level == GGML_LOG_LEVEL_WARN || level == GGML_LOG_LEVEL_ERROR)
                        std::fputs(text, stderr);
                },
                nullptr);
            llama_backend_init();
            ggml_backend_load_all();
        });
        auto mp = llama_model_default_params();
        // Offload is a MODEL setting. Queries must own a separate CPU model.
        ggml_backend_dev_t cpu_only[] = {nullptr};
        auto gpu = ggml_backend_dev_by_type(GGML_BACKEND_DEVICE_TYPE_GPU);
        accelerated = !query && !force_cpu && gpu &&
            !(std::getenv("BETTER_SEARCH_DEVICE") && std::string(std::getenv("BETTER_SEARCH_DEVICE")) == "cpu");
        mp.n_gpu_layers = accelerated ? 99 : 0;
        if (!accelerated) mp.devices = cpu_only;
        model = llama_model_load_from_file(utf8(path).c_str(), mp);
        if (!model)
            throw std::runtime_error("Cannot load local EmbeddingGemma 2 GGUF; run npm run setup");
        if (llama_model_n_embd_out(model) != 768) {
            llama_model_free(model);
            model = nullptr;
            throw std::runtime_error("Model must produce 768 embedding dimensions");
        }
        auto cp = llama_context_default_params();
        cp.n_ctx = std::getenv("BETTER_SEARCH_BATCH_TOKENS")
                       ? std::clamp(std::stoi(std::getenv("BETTER_SEARCH_BATCH_TOKENS")), 8192, 32768)
                       : 8192;
        cp.n_batch = cp.n_ctx;
        cp.n_ubatch = cp.n_ctx;
        cp.n_seq_max =
            std::getenv("BETTER_SEARCH_BATCH_DOCUMENTS")
                ? std::clamp(std::stoi(std::getenv("BETTER_SEARCH_BATCH_DOCUMENTS")), 1, 128)
                : 4;
        if (query) {
            cp.n_ctx = cp.n_batch = cp.n_ubatch = 4096;
            cp.n_seq_max = 1;
            cp.offload_kqv = false;
            cp.op_offload = false;
        }
        cp.kv_unified = true;
        cp.embeddings = true;
        cp.pooling_type = LLAMA_POOLING_TYPE_MEAN;
        cp.attention_type = LLAMA_ATTENTION_TYPE_NON_CAUSAL;
        cp.flash_attn_type = !accelerated ? LLAMA_FLASH_ATTN_TYPE_DISABLED : LLAMA_FLASH_ATTN_TYPE_ENABLED;
        cp.n_threads = std::min(16u, std::max(1u, std::thread::hardware_concurrency() / 2));
        cp.n_threads_batch = cp.n_threads;
        if (query) {
            cp.n_threads = std::getenv("BETTER_SEARCH_QUERY_THREADS")
                ? std::clamp(std::stoi(std::getenv("BETTER_SEARCH_QUERY_THREADS")), 1, 16) : std::min(8u, std::max(1u, std::thread::hardware_concurrency() / 2));
            cp.n_threads_batch = cp.n_threads;
        }
        int workers = std::getenv("BETTER_SEARCH_EMBED_WORKERS")
                          ? std::clamp(std::stoi(std::getenv("BETTER_SEARCH_EMBED_WORKERS")), 1, 4)
                          : 1;
        if (query) workers = 1;
        for (int i = 0; i < workers; ++i) {
            auto *ctx = llama_init_from_model(model, cp);
            if (!ctx) {
                for (auto *prev : contexts)
                    llama_free(prev);
                llama_model_free(model);
                model = nullptr;
                throw std::runtime_error("Cannot initialize native embedding context");
            }
            contexts.push_back(ctx);
            busy.push_back(false);
        }
    }
    ~Inference() {
        for (auto *ctx : contexts)
            llama_free(ctx);
        if (model)
            llama_model_free(model);
    }
    size_t acquire(bool query) {
        std::unique_lock lock(pool_mutex);
        if (query)
            ++waiting_queries;
        available.wait(lock, [&] {
            return (query || waiting_queries == 0) &&
                   std::find(busy.begin(), busy.end(), false) != busy.end();
        });
        if (query)
            --waiting_queries;
        auto slot = static_cast<size_t>(std::find(busy.begin(), busy.end(), false) - busy.begin());
        busy[slot] = true;
        return slot;
    }
    void release(size_t slot) {
        {
            std::lock_guard lock(pool_mutex);
            busy[slot] = false;
        }
        available.notify_all();
    }
};
static std::vector<std::vector<float>> encode_context(Engine &engine, llama_context *ctx,
                                                      llama_model *model,
                                                      const std::vector<std::string> &texts,
                                                      bool query) {
    auto *vocab = llama_model_get_vocab(model);
    std::vector<std::vector<float>> result;
    // Bound batches by total tokens, preserving whole sequences and UTF-8 text.
    size_t cursor = 0;
    const int capacity = static_cast<int>(llama_n_batch(ctx));
    const int max_documents = static_cast<int>(llama_n_seq_max(ctx));
    while (cursor < texts.size()) {
        auto batch = llama_batch_init(capacity, 0, 1);
        batch.n_tokens = 0;
        size_t count = 0;
        try {
            auto tokenize_start = std::chrono::steady_clock::now();
            for (size_t i = cursor; i < texts.size() && count < static_cast<size_t>(max_documents);
                 ++i) {
                auto text = query ? "task: search result | query: " + texts[i] : texts[i];
                // UTF-8 byte count is a conservative bound for normal byte-level
                // tokenization. Avoid tokenizing every chunk twice just to size it.
                std::vector<llama_token> tokens(std::min<size_t>(8192, text.size() + 16));
                int n = llama_tokenize(vocab, text.c_str(), static_cast<int>(text.size()),
                                       tokens.data(), static_cast<int>(tokens.size()), true, false);
                if (n < 0 && -n <= 8192) {
                    tokens.resize(-n);
                    n = llama_tokenize(vocab, text.c_str(), static_cast<int>(text.size()),
                                       tokens.data(), static_cast<int>(tokens.size()), true, false);
                }
                if (n <= 0 || n > 8192)
                    throw std::runtime_error("Embedding input outside model token limit");
                if (n > capacity) throw std::runtime_error("Query exceeds inference context capacity");
                if (batch.n_tokens + n > capacity)
                    break;
                for (int j = 0; j < n; ++j) {
                    auto k = batch.n_tokens++;
                    batch.token[k] = tokens[j];
                    batch.pos[k] = j;
                    batch.n_seq_id[k] = 1;
                    batch.seq_id[k][0] = static_cast<llama_seq_id>(count);
                    batch.logits[k] = 1;
                }
                ++count;
            }
            auto tokenize_ms = std::chrono::duration<double, std::milli>(
                                   std::chrono::steady_clock::now() - tokenize_start)
                                   .count();
            auto model_start = std::chrono::steady_clock::now();
            llama_memory_clear(llama_get_memory(ctx), true);
            auto rc = llama_model_has_encoder(model) ? llama_encode(ctx, batch)
                                                     : llama_decode(ctx, batch);
            if (rc != 0)
                throw std::runtime_error("Native embedding evaluation failed: " +
                                         std::to_string(rc));
            for (size_t i = 0; i < count; ++i) {
                const float *emb = llama_get_embeddings_seq(ctx, static_cast<llama_seq_id>(i));
                if (!emb)
                    throw std::runtime_error("Missing pooled sequence embedding");
                std::vector<float> v(emb, emb + 768);
                double norm = 0;
                for (float f : v) {
                    if (!std::isfinite(f))
                        throw std::runtime_error("Non-finite embedding");
                    norm += f * f;
                }
                if (norm < 1e-12)
                    throw std::runtime_error("Empty embedding");
                for (auto &f : v)
                    f = static_cast<float>(f / std::sqrt(norm));
                result.push_back(std::move(v));
            }
            if (!query) {
                std::lock_guard profile_lock(engine.performance_mutex);
                auto &performance = engine.performance;
                performance["tokenize_ms"] = performance["tokenize_ms"].get<double>() + tokenize_ms;
                performance["model_ms"] = performance["model_ms"].get<double>() +
                                          std::chrono::duration<double, std::milli>(
                                              std::chrono::steady_clock::now() - model_start)
                                              .count();
                performance["batches"] = performance["batches"].get<int>() + 1;
                performance["documents"] = performance["documents"].get<int>() + count;
                performance["tokens"] = performance["tokens"].get<int64_t>() + batch.n_tokens;
            }
            llama_batch_free(batch);
            cursor += count;
        } catch (...) {
            llama_batch_free(batch);
            throw;
        }
    }
    return result;
}
std::vector<std::vector<float>> Engine::encode(const std::vector<std::string> &texts, bool query) {
    json model_config;
    {std::lock_guard lock(mutex); model_config = config;}
    if (texts.empty())
        return {};
    std::string cache_key;
    if (query && texts.size() == 1) {
        cache_key = str(model_config, "model_sha256") + ":search-prefix-v1:" + texts.front();
        std::lock_guard lock(cache_mutex);
        for (size_t i = 0; i < query_cache.size(); ++i) if (query_cache[i].first == cache_key) {
            auto value = query_cache[i];
            query_cache.erase(query_cache.begin() + i);
            query_cache.push_back(value);
            return {value.second};
        }
    }
    std::shared_ptr<Inference> runtime;
    {
        std::lock_guard lock(query ? query_inference_mutex : inference_mutex);
        auto &selected = query ? query_inference : index_inference;
        if (!selected) {
            auto model_path = fs::u8path(str(model_config, "model_file"));
            try { selected = std::make_shared<Inference>(model_path, query); }
            catch (...) {
                if (query) throw;
                selected = std::make_shared<Inference>(model_path, false, true);
            }
        }
        runtime = selected;
    }
    if (!query) {
        std::lock_guard lock(performance_mutex);
        performance["backend"] = runtime->accelerated ? "gpu" : "cpu";
        performance["workers"] = runtime->contexts.size();
        performance["batch_documents"] = llama_n_seq_max(runtime->contexts.front());
        performance["batch_tokens"] = llama_n_batch(runtime->contexts.front());
    }
    size_t group_size = llama_n_seq_max(runtime->contexts.front());
    std::vector<std::vector<float>> result(texts.size());
    std::atomic<size_t> next = 0;
    std::atomic<bool> failed = false;
    std::mutex error_mutex;
    std::exception_ptr error;
    auto work = [&] {
        while (!failed) {
            size_t offset = next.fetch_add(group_size);
            if (offset >= texts.size())
                return;
            size_t end = std::min(offset + group_size, texts.size());
            auto slot = runtime->acquire(query);
            try {
                auto values = encode_context(
                    *this, runtime->contexts[slot], runtime->model,
                    std::vector<std::string>(texts.begin() + offset, texts.begin() + end), query);
                for (size_t i = 0; i < values.size(); ++i)
                    result[offset + i] = std::move(values[i]);
                runtime->release(slot);
            } catch (...) {
                runtime->release(slot);
                std::lock_guard lock(error_mutex);
                if (!error)
                    error = std::current_exception();
                failed = true;
            }
        }
    };
    size_t workers =
        std::min(runtime->contexts.size(), (texts.size() + group_size - 1) / group_size);
    std::vector<std::jthread> threads;
    for (size_t i = 1; i < workers; ++i)
        threads.emplace_back(work);
    work();
    for (auto &t : threads)
        t.join();
    if (error) {
        if (!query && runtime->accelerated) {
            { std::lock_guard lock(inference_mutex); index_inference.reset(); }
            runtime.reset();
            auto fallback = std::make_shared<Inference>(fs::u8path(str(model_config, "model_file")), false, true);
            { std::lock_guard lock(inference_mutex); index_inference = std::move(fallback); }
            return encode(texts, false);
        }
        std::rethrow_exception(error);
    }
    if (!cache_key.empty()) {
        std::lock_guard lock(cache_mutex);
        if (query_cache.size() >= 64) query_cache.erase(query_cache.begin());
        query_cache.emplace_back(cache_key, result.front());
    }
    return result;
}
} // namespace bettersearch
