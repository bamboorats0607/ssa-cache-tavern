# ══════════════════════════════════════════════════════════════════════════
# Tavern 发布版 ProGuard / R8 规则
#
# 背景：本工程启用 minifyEnabled + shrinkResources 后，R8 会重命名类与方法。
# 但有两类东西**不能改名**，否则运行时直接崩：
#   1) JNI native 方法（C++ 侧按 `Java_<包名>_<类名>_<方法名>` 查找符号）
#   2) Android 组件与反射入口（Manifest 声明的类由系统按名加载）
# 下面逐条给出理由，避免后人误删。
# ══════════════════════════════════════════════════════════════════════════

# ── 1. JNI 入口（关键，删掉必崩）──────────────────────────────────────────
# native-lib.cpp:80 导出的是
#   Java_dev_tavern_shell_MainActivity_startNodeWithArguments
# 该符号名由「包名+类名+方法名」拼成。R8 一旦把 MainActivity 或
# startNodeWithArguments 改名，JNI 查找就会失败并抛 UnsatisfiedLinkError
# —— 表现为 App 一启动就崩（内嵌后端起不来）。
-keep class dev.tavern.shell.MainActivity { *; }
-keepclasseswithmembernames class * {
    native <methods>;
}

# ── 2. Android 组件（Manifest 按名加载，不能混淆）─────────────────────────
-keep public class * extends android.app.Activity
-keep public class * extends android.app.Application
-keep public class * extends android.app.Service
-keep public class * extends android.content.BroadcastReceiver
-keep public class * extends android.content.ContentProvider
-keep public class * extends androidx.core.content.FileProvider

# ── 3. Capacitor 桥接 ─────────────────────────────────────────────────────
# Capacitor 通过反射调用插件方法（@PluginMethod 注解标记），
# 且 WebView 的 JS 接口依赖类名与方法签名，故整体保留插件类。
-keep class com.getcapacitor.** { *; }
-keep @com.getcapacitor.annotation.CapacitorPlugin class * { *; }
-keep class * extends com.getcapacitor.Plugin { *; }
-keepclassmembers class * extends com.getcapacitor.Plugin {
    @com.getcapacitor.PluginMethod public *;
}

# ── 4. WebView 的 JavascriptInterface ─────────────────────────────────────
# 被 @JavascriptInterface 标注的方法由 WebView 通过反射按名调用。
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}

# ── 5. 保留必要属性（否则崩溃日志无行号，难以排查线上问题）───────────────
-keepattributes SourceFile,LineNumberTable
# 混淆后不暴露原始文件名
-renamesourcefileattribute SourceFile
-keepattributes *Annotation*, Signature, InnerClasses, EnclosingMethod

# ── 6. 抑制 R8 对缺失引用类的告警 ─────────────────────────────────────────
# Capacitor/AndroidX 存在大量编译期可选依赖，运行期可能不存在。
-dontwarn org.apache.**
-dontwarn com.google.**
-dontwarn org.jetbrains.annotations.**
-dontwarn kotlin.**
-dontwarn kotlinx.**
