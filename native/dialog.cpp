#include <gtk/gtk.h>
#include <iostream>
#include <string>

// A separate process keeps GTK's main loop on its own main thread.
// GtkFileChooserNative uses the desktop portal when configured, or the native GTK picker.
int main(int argc, char **argv) {
    if (!gtk_init_check(nullptr, nullptr)) return 2;
    g_set_application_name("BetterSearch");
    bool self_test = argc == 2 && std::string(argv[1]) == "--self-test";
    if (!self_test && (argc != 6 || (std::string(argv[1]) != "save" && std::string(argv[1]) != "folder"))) return 2;
    bool save = !self_test && std::string(argv[1]) == "save";
    auto *dialog = gtk_file_chooser_native_new(self_test ? "BetterSearch" : argv[2], nullptr,
        save ? GTK_FILE_CHOOSER_ACTION_SAVE : GTK_FILE_CHOOSER_ACTION_SELECT_FOLDER,
        self_test ? nullptr : argv[3], self_test ? nullptr : argv[4]);
    auto *chooser = GTK_FILE_CHOOSER(dialog);
    gtk_file_chooser_set_local_only(chooser, TRUE);
    if (save) {
        gtk_file_chooser_set_current_name(chooser, "better-search-diagnostics.json");
        gtk_file_chooser_set_do_overwrite_confirmation(chooser, TRUE);
        auto *filter = gtk_file_filter_new();
        gtk_file_filter_set_name(filter, argv[5]);
        gtk_file_filter_add_pattern(filter, "*.json");
        gtk_file_chooser_add_filter(chooser, filter);
    }
    if (self_test) {g_object_unref(dialog); return 0;}
    auto response = gtk_native_dialog_run(GTK_NATIVE_DIALOG(dialog));
    int code = 1;
    if (response == GTK_RESPONSE_ACCEPT) {
        auto *filename = gtk_file_chooser_get_filename(chooser);
        if (filename) {std::cout << filename; g_free(filename); code = 0;}
        else code = 2;
    }
    g_object_unref(dialog);
    return code;
}
