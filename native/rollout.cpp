#include "search.hpp"
#include "zstd.h"
#include <array>

namespace bettersearch {
void each_rollout_line(const fs::path &path,
                       const std::function<bool(const std::string &, int64_t)> &visit) {
    std::ifstream input(path, std::ios::binary);
    if (!input)
        throw std::runtime_error("Cannot read rollout: " + utf8(path.filename()));
    int64_t ordinal = 0;
    if (path.extension() != ".zst") {
        std::string line;
        while (std::getline(input, line))
            if (!visit(line, ++ordinal))
                return;
        return;
    }
    std::unique_ptr<ZSTD_DStream, decltype(&ZSTD_freeDStream)> decoder(ZSTD_createDStream(),
                                                                       ZSTD_freeDStream);
    if (!decoder)
        throw std::runtime_error("Cannot allocate Zstandard decoder");
    auto code = ZSTD_initDStream(decoder.get());
    if (ZSTD_isError(code))
        throw std::runtime_error(ZSTD_getErrorName(code));
    std::array<char, 65536> compressed, decoded;
    std::string pending;
    while (input) {
        input.read(compressed.data(), compressed.size());
        ZSTD_inBuffer in{compressed.data(), static_cast<size_t>(input.gcount()), 0};
        while (in.pos < in.size) {
            ZSTD_outBuffer out{decoded.data(), decoded.size(), 0};
            code = ZSTD_decompressStream(decoder.get(), &out, &in);
            if (ZSTD_isError(code))
                throw std::runtime_error("Invalid Zstandard rollout: " +
                                         std::string(ZSTD_getErrorName(code)));
            pending.append(decoded.data(), out.pos);
            size_t start = 0, newline;
            while ((newline = pending.find('\n', start)) != std::string::npos) {
                if (!visit(pending.substr(start, newline - start), ++ordinal))
                    return;
                start = newline + 1;
            }
            pending.erase(0, start);
        }
    }
    if (code != 0)
        throw std::runtime_error("Incomplete Zstandard rollout");
    if (!pending.empty())
        visit(pending, ++ordinal);
}
} // namespace bettersearch
