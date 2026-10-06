/* Vcodex-Chamber microphone bridge (MIT). PvRecorder/miniaudio are built
 * separately from their pinned upstream sources; see the packaged licenses.
 * stdout is exclusively little-endian mono PCM16. Control uses stdin and
 * newline-delimited JSON on stderr. No audio files are created. */
#define _POSIX_C_SOURCE 200809L
#include <ctype.h>
#include <poll.h>
#include <pthread.h>
#include <signal.h>
#include <stdatomic.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include "pv_recorder.h"

static atomic_bool stopping = 0;
static atomic_bool failed = 0;
static volatile sig_atomic_t interrupted = 0;
static void on_signal(int sig) { (void)sig; interrupted = 1; }
static void json_string(FILE *out, const char *s) {
    fputc('"', out);
    for (const unsigned char *p = (const unsigned char *)s; *p; ++p) {
        if (*p == '"' || *p == '\\') { fputc('\\', out); fputc(*p, out); }
        else if (*p < 32) fprintf(out, "\\u%04x", *p);
        else fputc(*p, out);
    }
    fputc('"', out);
}
static int error(const char *message) {
    fputs("{\"status\":\"error\",\"reason\":", stderr);
    json_string(stderr, message);
    fputs("}\n", stderr);
    return 1;
}
static int is_monitor(const char *name) {
    char lower[1024]; size_t i = 0;
    for (; name[i] && i < sizeof(lower) - 1; ++i) lower[i] = (char)tolower((unsigned char)name[i]);
    lower[i] = 0;
    return strstr(lower, "monitor") != NULL;
}
static void *capture(void *arg) {
    pv_recorder_t *recorder = arg;
    int16_t frame[512]; unsigned char bytes[1024];
    while (!atomic_load(&stopping) && !interrupted) {
        pv_recorder_status_t status = pv_recorder_read(recorder, frame);
        if (status != PV_RECORDER_STATUS_SUCCESS) {
            error(pv_recorder_status_to_string(status)); atomic_store(&failed, 1); break;
        }
        for (int i = 0; i < 512; ++i) { bytes[2*i] = (uint16_t)frame[i] & 255; bytes[2*i+1] = (uint16_t)frame[i] >> 8; }
        if (fwrite(bytes, 1, sizeof(bytes), stdout) != sizeof(bytes)) { atomic_store(&failed, 1); break; }
    }
    return NULL;
}
int main(int argc, char **argv) {
    setvbuf(stdout, NULL, _IONBF, 0); setvbuf(stderr, NULL, _IONBF, 0);
    if (argc == 2 && strcmp(argv[1], "--version") == 0) {
        printf("Vcodex ARM audio / PvRecorder %s\n", pv_recorder_version()); return 0;
    }
    const char *requested = NULL;
    int listing = argc == 2 && strcmp(argv[1], "--list-devices") == 0;
    if (argc == 3 && strcmp(argv[1], "--device") == 0) requested = argv[2];
    else if (argc != 1 && !listing) return error("Usage: recorder [--device NAME | --list-devices | --version]");
    int32_t count = 0; char **devices = NULL;
    pv_recorder_status_t status = pv_recorder_get_available_devices(&count, &devices);
    if (status != PV_RECORDER_STATUS_SUCCESS) return error(pv_recorder_status_to_string(status));
    if (listing) {
        fputc('[', stdout);
        for (int32_t i = 0; i < count; ++i) { if (i) fputc(',', stdout); json_string(stdout, devices[i]); }
        fputs("]\n", stdout); pv_recorder_free_available_devices(count, devices); return 0;
    }
    int32_t selected = -1;
    for (int32_t i = 0; i < count; ++i) {
        if (requested ? strcmp(requested, devices[i]) == 0 : !is_monitor(devices[i])) { selected = i; break; }
    }
    if (selected < 0) { pv_recorder_free_available_devices(count, devices); return error(requested ? "Configured microphone not found" : "No microphone input device; loopback monitors are excluded"); }
    pv_recorder_t *recorder = NULL;
    status = pv_recorder_init(512, selected, 100, &recorder);
    if (status != PV_RECORDER_STATUS_SUCCESS) { pv_recorder_free_available_devices(count, devices); return error(pv_recorder_status_to_string(status)); }
    status = pv_recorder_start(recorder);
    if (status != PV_RECORDER_STATUS_SUCCESS) { pv_recorder_delete(recorder); pv_recorder_free_available_devices(count, devices); return error(pv_recorder_status_to_string(status)); }
    signal(SIGTERM, on_signal); signal(SIGINT, on_signal); signal(SIGPIPE, SIG_IGN);
    pthread_t thread;
    if (pthread_create(&thread, NULL, capture, recorder) != 0) { pv_recorder_stop(recorder); pv_recorder_delete(recorder); pv_recorder_free_available_devices(count, devices); return error("Cannot create capture thread"); }
    fprintf(stderr, "{\"status\":\"started\",\"sampleRate\":%d,\"device\":", pv_recorder_sample_rate());
    json_string(stderr, devices[selected]); fputs("}\n", stderr);
    pv_recorder_free_available_devices(count, devices);
    struct pollfd input = {.fd = STDIN_FILENO, .events = POLLIN | POLLHUP};
    while (!interrupted && !atomic_load(&failed)) {
        int ready = poll(&input, 1, 100);
        if (ready > 0) { char command[16]; ssize_t n = read(STDIN_FILENO, command, sizeof(command)); if (n <= 0 || (n >= 4 && memcmp(command, "stop", 4) == 0)) break; }
        else if (ready < 0 && !interrupted) { atomic_store(&failed, 1); break; }
    }
    atomic_store(&stopping, 1);
    pthread_join(thread, NULL); /* Drain the final frame before stop closes stdout. */
    pv_recorder_stop(recorder); pv_recorder_delete(recorder);
    fputs("{\"status\":\"stopped\"}\n", stderr);
    return atomic_load(&failed) ? 1 : 0;
}
