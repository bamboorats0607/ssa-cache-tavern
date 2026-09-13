// S5 内嵌后端：JNI 桥接，从 Android 侧启动 libnode 运行时。
// 逻辑与 nodejs-mobile 官方 sample 的 startNodeWithArguments 一致：
// node 的 libuv 要求 argv 位于连续内存。
//
// 额外：把 Node 的 stdout/stderr 经管道转发到 logcat（tag: TavernNode）。
// 官方 sample 不含这一步，但没有它就无法看到 Node 侧的启动错误。
#include <jni.h>
#include <string>
#include <cstdlib>
#include <cstring>
#include <unistd.h>
#include <pthread.h>
#include <android/log.h>
#include "node.h"

#define LOG_TAG "TavernNode"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, LOG_TAG, __VA_ARGS__)
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, LOG_TAG, __VA_ARGS__)

namespace {

struct PipeForward {
    int readFd;
    int priority;
};

void* ForwardToLogcat(void* arg) {
    PipeForward* pf = static_cast<PipeForward*>(arg);
    char buf[1024];
    std::string pending;
    ssize_t n;
    while ((n = read(pf->readFd, buf, sizeof(buf) - 1)) > 0) {
        buf[n] = '\0';
        pending += buf;
        size_t pos;
        while ((pos = pending.find('\n')) != std::string::npos) {
            std::string line = pending.substr(0, pos);
            if (!line.empty() && line.back() == '\r') line.pop_back();
            __android_log_write(pf->priority, LOG_TAG, line.c_str());
            pending.erase(0, pos + 1);
        }
    }
    if (!pending.empty()) {
        __android_log_write(pf->priority, LOG_TAG, pending.c_str());
    }
    return nullptr;
}

// 把 STDOUT/STDERR 接到管道，并由后台线程转发到 logcat。
void RedirectStdioToLogcat() {
    int outPipe[2];
    int errPipe[2];
    if (pipe(outPipe) != 0 || pipe(errPipe) != 0) {
        LOGE("pipe() failed");
        return;
    }

    dup2(outPipe[1], STDOUT_FILENO);
    dup2(errPipe[1], STDERR_FILENO);
    close(outPipe[1]);
    close(errPipe[1]);

    // 关闭 stdio 缓冲，确保 Node 的输出立即写出
    setvbuf(stdout, nullptr, _IONBF, 0);
    setvbuf(stderr, nullptr, _IONBF, 0);

    static PipeForward stdoutForward { outPipe[0], ANDROID_LOG_INFO };
    static PipeForward stderrForward { errPipe[0], ANDROID_LOG_ERROR };

    pthread_t tOut;
    pthread_t tErr;
    pthread_create(&tOut, nullptr, ForwardToLogcat, &stdoutForward);
    pthread_create(&tErr, nullptr, ForwardToLogcat, &stderrForward);
    pthread_detach(tOut);
    pthread_detach(tErr);
}

} // namespace

extern "C" jint JNICALL
Java_dev_tavern_shell_MainActivity_startNodeWithArguments(
        JNIEnv *env,
        jobject /* this */,
        jobjectArray arguments) {

    // argc
    jsize argument_count = env->GetArrayLength(arguments);

    // 计算连续缓冲区所需字节数（libuv 要求 argv 连续）
    int c_arguments_size = 0;
    for (int i = 0; i < argument_count; i++) {
        const char* a = env->GetStringUTFChars((jstring) env->GetObjectArrayElement(arguments, i), 0);
        c_arguments_size += strlen(a);
        c_arguments_size++; // for '\0'
        env->ReleaseStringUTFChars((jstring) env->GetObjectArrayElement(arguments, i), a);
    }

    char* args_buffer = (char*) calloc(c_arguments_size, sizeof(char));
    char* argv[argument_count];

    char* current_args_position = args_buffer;
    for (int i = 0; i < argument_count; i++) {
        jstring js = (jstring) env->GetObjectArrayElement(arguments, i);
        const char* current_argument = env->GetStringUTFChars(js, 0);
        strncpy(current_args_position, current_argument, strlen(current_argument));
        argv[i] = current_args_position;
        current_args_position += strlen(current_args_position) + 1;
        env->ReleaseStringUTFChars(js, current_argument);
    }

    RedirectStdioToLogcat();

    LOGI("Starting Node.js runtime with %d args", argument_count);
    for (int i = 0; i < argument_count; i++) {
        LOGI("  argv[%d] = %s", i, argv[i]);
    }

    jint result = node::Start(argument_count, argv);
    LOGI("Node.js runtime exited with code %d", result);
    free(args_buffer);
    return result;
}
