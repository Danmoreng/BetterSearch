#include "search.hpp"
#include <cstdlib>
#ifdef _WIN32
#include <windows.h>
#include <shobjidl.h>
#else
#include <cerrno>
#include <csignal>
#include <fcntl.h>
#include <spawn.h>
#include <sys/wait.h>
#include <unistd.h>
extern char **environ;
#endif

namespace bettersearch {
static fs::path environment_path(const char *name) {
    auto value = std::getenv(name);
    return value && *value ? fs::u8path(value) : fs::path{};
}
fs::path default_data_home() {
    auto override = environment_path("BETTER_SEARCH_HOME");
    if (!override.empty()) return override;
#ifdef _WIN32
    auto base = environment_path("LOCALAPPDATA");
    if (base.empty()) base = environment_path("USERPROFILE") / "AppData" / "Local";
#else
    auto base = environment_path("XDG_DATA_HOME");
    if (base.empty()) base = environment_path("HOME") / ".local" / "share";
#endif
    return base / "BetterSearch";
}
static fs::path package_root() {
#ifdef _WIN32
    wchar_t executable[32768];
    auto count = GetModuleFileNameW(nullptr, executable, 32768);
    if (!count || count >= 32768) throw ServiceFailure("BINARY_MISSING");
    auto file = fs::path(std::wstring(executable, count));
#else
    auto file = fs::read_symlink("/proc/self/exe");
#endif
    return file.parent_path().parent_path().parent_path();
}

#ifndef _WIN32
// posix_spawn avoids running C++ or a shell in a forked, multithreaded process.
static int run_child(const fs::path &executable, const std::vector<std::string> &arguments,
                     const std::atomic<bool> &stopping, std::string *output = nullptr) {
    int pipefd[2] = {-1, -1};
    if (output && pipe2(pipefd, O_CLOEXEC) != 0) return -1;
    posix_spawn_file_actions_t actions;
    if (posix_spawn_file_actions_init(&actions) != 0) {
        if (output) {close(pipefd[0]); close(pipefd[1]);}
        return -1;
    }
    int setup = posix_spawn_file_actions_addopen(&actions, STDIN_FILENO, "/dev/null", O_RDONLY, 0);
    if (output) {
        setup |= posix_spawn_file_actions_adddup2(&actions, pipefd[1], STDOUT_FILENO);
        setup |= posix_spawn_file_actions_addclose(&actions, pipefd[0]);
        setup |= posix_spawn_file_actions_addclose(&actions, pipefd[1]);
    }
    auto name = utf8(executable);
    std::vector<char *> argv{name.data()};
    for (const auto &arg : arguments) argv.push_back(const_cast<char *>(arg.c_str()));
    argv.push_back(nullptr);
    pid_t pid = -1;
    auto spawned = setup ? setup : posix_spawn(&pid, name.c_str(), &actions, nullptr, argv.data(), environ);
    posix_spawn_file_actions_destroy(&actions);
    if (output) close(pipefd[1]);
    if (spawned) {if (output) close(pipefd[0]); return -1;}
    if (output) fcntl(pipefd[0], F_SETFL, O_NONBLOCK);
    auto drain = [&] {
        if (!output) return;
        char buffer[4096];
        ssize_t count;
        while ((count = read(pipefd[0], buffer, sizeof(buffer))) > 0) {
            if (output->size() + size_t(count) > 1024 * 1024) {kill(pid, SIGKILL); return;}
            output->append(buffer, size_t(count));
        }
    };
    int status = 0;
    bool terminating = false;
    auto deadline = std::chrono::steady_clock::time_point::max();
    for (;;) {
        drain();
        auto waited = waitpid(pid, &status, WNOHANG);
        if (waited == pid) break;
        if (waited < 0 && errno != EINTR) {status = -1; break;}
        if (stopping && !terminating) {
            kill(pid, SIGTERM); terminating = true;
            deadline = std::chrono::steady_clock::now() + std::chrono::seconds(2);
        }
        if (terminating && std::chrono::steady_clock::now() >= deadline) kill(pid, SIGKILL);
        std::this_thread::sleep_for(std::chrono::milliseconds(30));
    }
    drain();
    if (output) close(pipefd[0]);
    return status >= 0 && WIFEXITED(status) ? WEXITSTATUS(status) : -1;
}
#endif

fs::path choose_path(bool save, const std::atomic<bool> &stopping) {
#ifdef _WIN32
    (void)stopping;
    auto initialized = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
    if (FAILED(initialized)) throw ServiceFailure("DIALOG_UNAVAILABLE");
    IFileDialog *dialog = nullptr;
    HRESULT result = save ? CoCreateInstance(CLSID_FileSaveDialog, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&dialog))
                          : CoCreateInstance(CLSID_FileOpenDialog, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&dialog));
    fs::path path;
    if (SUCCEEDED(result)) {
        DWORD flags = 0; dialog->GetOptions(&flags);
        dialog->SetOptions(flags | FOS_FORCEFILESYSTEM | (save ? FOS_OVERWRITEPROMPT : FOS_PICKFOLDERS | FOS_PATHMUSTEXIST));
        if (save) {dialog->SetFileName(L"better-search-diagnostics.json"); dialog->SetDefaultExtension(L"json");}
        result = dialog->Show(GetForegroundWindow());
        if (SUCCEEDED(result)) {
            IShellItem *item = nullptr;
            if (SUCCEEDED(dialog->GetResult(&item))) {
                PWSTR value = nullptr;
                if (SUCCEEDED(item->GetDisplayName(SIGDN_FILESYSPATH, &value))) {path = value; CoTaskMemFree(value);}
                item->Release();
            }
        }
        dialog->Release();
    }
    CoUninitialize();
    if (FAILED(result) && result != HRESULT_FROM_WIN32(ERROR_CANCELLED)) throw ServiceFailure("DIALOG_UNAVAILABLE");
    return path;
#else
    auto root = package_root();
    auto labels = json::parse(read_file(root / "locales/en.json"));
    std::string output;
    auto code = run_child(root / "dist/native/better-search-dialog",
        {save ? "save" : "folder", labels.at(save ? "dialog.export" : "dialog.source").get<std::string>(),
         labels.at(save ? "dialog.save" : "dialog.select").get<std::string>(), labels.at("settings.cancel").get<std::string>(),
         labels.at("dialog.jsonFiles").get<std::string>()}, stopping, &output);
    if (code == 1) return {};
    if (code != 0 || output.empty()) throw ServiceFailure("DIALOG_UNAVAILABLE");
    return fs::u8path(output);
#endif
}

bool run_model_helper(const fs::path &home, const std::atomic<bool> &stopping) {
    auto root = package_root();
    auto script = root / "scripts/setup-model.mjs";
#ifdef _WIN32
    auto node = root / "dist/runtime/node.exe";
    auto quote = [](const fs::path &path) {
        auto text = path.wstring();
        size_t trailing = 0;
        while (trailing < text.size() && text[text.size() - trailing - 1] == L'\\') ++trailing;
        return L"\"" + text + std::wstring(trailing, L'\\') + L"\"";
    };
    auto command = quote(node) + L" " + quote(script) + L" --home " + quote(home);
    STARTUPINFOW startup{}; startup.cb = sizeof(startup); PROCESS_INFORMATION process{};
    if (!CreateProcessW(node.c_str(), command.data(), nullptr, nullptr, FALSE, CREATE_NO_WINDOW, nullptr, root.c_str(), &startup, &process)) return false;
    CloseHandle(process.hThread);
    while (WaitForSingleObject(process.hProcess, 200) == WAIT_TIMEOUT) {
        if (stopping) {TerminateProcess(process.hProcess, 1); WaitForSingleObject(process.hProcess, INFINITE); break;}
    }
    DWORD code = 1; GetExitCodeProcess(process.hProcess, &code); CloseHandle(process.hProcess);
    return code == 0;
#else
    return run_child(root / "dist/runtime/node", {utf8(script), "--home", utf8(home)}, stopping) == 0;
#endif
}
} // namespace bettersearch
