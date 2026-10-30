# Third-party components

BetterSearch builds the following native components from source:

- llama.cpp and ggml: MIT, copyright © 2023–2026 The ggml authors. The exact source is pinned in `third_party/llama.cpp`; see its LICENSE and third-party notices.
- SQLite 3.54.1: public domain. https://www.sqlite.org/copyright.html
- Zstandard 1.5.7: BSD-3-Clause or GPL-2.0; this build uses the BSD license. Copyright © Meta Platforms, Inc. and affiliates. https://github.com/facebook/zstd
- sqlite-vec 0.1.9: MIT or Apache-2.0, copyright © Alex Garcia. https://github.com/asg017/sqlite-vec
- cpp-httplib 0.63.0: MIT, copyright © Yuji Hirose. https://github.com/yhirose/cpp-httplib
- nlohmann/json 3.12.0: MIT, copyright © 2013–2025 Niels Lohmann. https://github.com/nlohmann/json

The TypeScript bridge and UI bundle dependencies listed in package-lock.json, including the MCP SDK and MCP Apps SDK (MIT), Zod (MIT), and their transitive dependencies. esbuild preserves legal notices in the generated bundles.

The locally downloaded model is Google's EmbeddingGemma 2 (Apache-2.0), converted to GGUF by ggml-org. Model weights are not included in the plugin package. The optional GPU development build uses CUDA components from the locally installed NVIDIA toolkit. The portable CPU package does not require CUDA or download a prebuilt llama.cpp runtime.

The Linux dialog helper dynamically links the system GTK 3 library. GTK is
provided and licensed by the Linux distribution; it is not bundled in the archive.

## MIT license

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.

## Zstandard BSD license

BSD License

For Zstandard software

Copyright (c) Meta Platforms, Inc. and affiliates. All rights reserved.

Redistribution and use in source and binary forms, with or without modification,
are permitted provided that the following conditions are met:

 * Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.

 * Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

 * Neither the name Facebook, nor Meta, nor the names of its contributors may
   be used to endorse or promote products derived from this software without
   specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR
ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
(INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON
ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

Each platform release bundles the exact Node.js runtime recorded in dist/build-info.json. Its full license and third-party notices are included as dist/runtime/NODE_LICENSE.txt. Additional native and npm license notices are included in licenses/.
