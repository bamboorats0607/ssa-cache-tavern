package dev.tavern.shell;

import android.content.Context;
import android.content.res.AssetManager;
import android.os.Bundle;
import android.util.Log;
import android.webkit.WebView;

import androidx.activity.OnBackPressedCallback;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;

import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeActivity;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;

/**
 * S5 内嵌后端：在 Capacitor WebView 之外，于后台线程启动内嵌的 Node.js 运行时，
 * 由 SillyBunny 后端在本机 127.0.0.1 上提供 API。
 *
 * 依据：
 *  - nodejs-mobile 官方「Building complex projects」：APK 是压缩包，Node 无法直接在包内运行，
 *    必须先把 nodejs-project 复制到 App 的 filesDir，再从该路径启动。
 *  - nodejs-mobile FAQ：Node 必须跑在独立后台线程，UI(WebView) 通过通信机制与它交互；
 *    不支持在 WebView 内运行 Node。
 *
 * libnode 符号由 CMake/JNI 桥接（app/src/main/cpp/native-lib.cpp）提供：
 *   private native int startNodeWithArguments(String[] args);
 */
public class MainActivity extends BridgeActivity {

    private static final String TAG = "TavernNode";
    private static final String NODE_PROJECT_ASSET = "nodejs-project";

    /**
     * Node 运行时是否已在本进程内启动过（进程级一次性守卫）。
     *
     * ── 为什么必须有这个守卫（2026-09-12 真机崩溃根因）────────────────────
     * 本 Activity 在 Manifest 中为 `launchMode="singleTask"`，但「singleTask」
     * 只保证任务栈内单实例，**不能阻止 onCreate 被再次调用**：
     * 从最近任务列表切回、系统回收后重建、配置变更等都会重新走 onCreate。
     *
     * 原实现无条件启动 Node，于是出现实测崩溃：
     *   ```
     *   19:36:07  pid=13649  Starting Node.js runtime     ← 首个实例，正常监听 4444
     *   19:37:52  pid=13649  Starting Node.js runtime     ← 同进程又启动一次
     *   19:37:53  pid=17114  libnode.so (node::Assert)
     *             Fatal signal 6 (SIGABRT) in tid (tavern-node-thr)
     *   ```
     * **同一进程内初始化两个 Node 运行时会让 Node 内部断言失败并 abort。**
     * 该竞态在模拟器上不复现（内存/时序差异掩盖），仅在真机触发 —— 故必须
     * 用静态标志把启动收敛为「每进程一次」。
     *
     * 用 `static` 而非实例字段：实例字段随 Activity 重建而重置，挡不住。
     * volatile + synchronized 保证多线程（onCreate 可能在不同线程）可见性与原子性。
     */
    private static volatile boolean nodeStarted = false;

    // 由 libtavernnode.so 提供（native-lib.cpp）
    public native int startNodeWithArguments(String[] args);

    static {
        System.loadLibrary("tavernnode");
    }

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        Log.i(TAG, "MainActivity onCreate — preparing embedded Node runtime");

        // 注册返回键处理器（必须放在下方「进程级判重 return」之前）。
        // 该注册只依赖 Activity 生命周期，不依赖 Node；若放在判重之后，Activity
        // 被系统重建时会因 nodeStarted==true 提前 return，导致返回键处理失效。
        registerBackHandler();

        // 状态栏安全区兜底注入（延迟 1.5s，避开 WebView 尚未就绪的时机）。
        // 注意：必须放在进程级判重之前 —— 判重分支会 return，若放在其后，
        // Activity 重建时就永远兜不到这一次注入。
        // 本块只做样式注入，绝不触碰 nodeStarted / Node 启动逻辑。
        final Bridge onCreateBridge = getBridge();
        final WebView webView = (onCreateBridge == null) ? null : onCreateBridge.getWebView();
        if (webView != null) {
            webView.postDelayed(new Runnable() {
                @Override
                public void run() {
                    applySafeAreaInsets();
                }
            }, 1500);
        }

        // 进程级判重：已启动过就直接返回，避免重复初始化 Node 导致断言崩溃。
        synchronized (MainActivity.class) {
            if (nodeStarted) {
                Log.i(TAG, "embedded Node already running in this process — skip");
                return;
            }
            nodeStarted = true;
        }

        final File nodeDir = new File(getFilesDir(), NODE_PROJECT_ASSET);
        // 持久数据根 / 持久配置根（必须外置，见下方线程内的原因注释）。
        final File dataRoot = new File(getFilesDir(), "tavern/data");
        final File configPath = new File(getFilesDir(), "tavern/config.yaml");
        new Thread(new Runnable() {
            @Override
            public void run() {
                try {
                    // 每次启动重建，保证随 APK 更新
                    deleteFolderRecursively(nodeDir);
                    nodeDir.mkdirs();
                    boolean copied = copyAssetFolder(getAssets(), NODE_PROJECT_ASSET, nodeDir.getAbsolutePath());
                    if (!copied) {
                        // 被中断的半成品解压目录会被下一次启动当作「上一次解压的成品」
                        // 而继续复用，症状是难以定位的「模块找不到」。这里必须显式报警。
                        Log.e(TAG, "copyAssetFolder returned false — extracted "
                            + NODE_PROJECT_ASSET + " may be incomplete: " + nodeDir);
                    }

                    // 数据根（角色卡 / 头像 / 背景 / 世界书）必须外置：
                    // nodeDir 每次启动先删后建，写入其中的用户数据会全部丢失。
                    // 不在 Java 侧手工播种种子文件 —— 上游 src/server-main.js 的启动链
                    // （initUserStorage(DATA_ROOT) → ensurePublicDirectoriesExist →
                    //   checkForNewContent）会自行从随包发布的 default/ 目录播种
                    // 默认用户与默认角色；此处只保证目录存在且可写。
                    if (!dataRoot.exists() && !dataRoot.mkdirs()) {
                        Log.e(TAG, "failed to create data root: " + dataRoot);
                    }

                    // 配置根同样外置，并在首启从解压目录播种一次。
                    // 之后不再覆盖，保留用户/上游对配置的修改。
                    if (!configPath.exists()) {
                        File seededConfig = new File(nodeDir, "config.yaml");
                        if (seededConfig.exists()) {
                            File configParent = configPath.getParentFile();
                            if (configParent != null && !configParent.exists()) {
                                configParent.mkdirs();
                            }
                            if (copyFileToFile(seededConfig, configPath)) {
                                Log.i(TAG, "seeded config.yaml -> " + configPath);
                            } else {
                                Log.e(TAG, "failed to seed config.yaml -> " + configPath);
                            }
                        } else {
                            // 不崩溃：让上游使用其内置默认值。
                            Log.w(TAG, "asset config.yaml not found at " + seededConfig
                                + " — skip seeding, upstream will use built-in defaults");
                        }
                    }

                    String scriptPath = new File(nodeDir, "main.js").getAbsolutePath();

                    Log.i(TAG, "starting node with script=" + scriptPath
                        + " dataRoot=" + dataRoot.getAbsolutePath()
                        + " configPath=" + configPath.getAbsolutePath());
                    // 注：不传 --experimental-default-type=module。
                    // 该 flag 在 Node 24 已被移除（实测退出码 9 = Invalid Argument）；
                    // nodejs-project/package.json 已声明 "type": "module"，等效且更稳。
                    int exitCode = startNodeWithArguments(new String[] {
                        "node",
                        scriptPath,
                        "--dataRoot", dataRoot.getAbsolutePath(),
                        "--configPath", configPath.getAbsolutePath(),
                    });
                    Log.i(TAG, "node exited: " + exitCode);
                    // Node 退出说明内嵌后端已不可用。复位标志，允许后续 onCreate
                    // 重新拉起（否则一次异常退出会让 App 永久处于「无后端」状态）。
                    nodeStarted = false;
                } catch (Throwable t) {
                    Log.e(TAG, "failed to start embedded node", t);
                    nodeStarted = false;
                }
            }
        }, "tavern-node-thread").start();
    }

    /**
     * 每次回到前台重试注入状态栏安全区（幂等，重复执行无副作用）。
     *
     * ⚠️ 本方法**只做样式注入**，绝不触碰 nodeStarted 标志、也绝不启动 Node。
     * Node 的启动仍严格限定在 onCreate 的进程级守卫内、且每进程仅一次。
     */
    @Override
    public void onResume() {
        super.onResume();
        applySafeAreaInsets();
    }

    /**
     * 注册返回键处理器：把「返回」的决策权交给 WebView 中的前端。
     *
     * ── 为什么用 OnBackPressedDispatcher 而非覆写 onBackPressed() ────────────
     * 本应用 compileSdk/targetSdk = 36，运行在 Android 16+ 真机上时「预测性返回」默认启用：
     * 系统不再调用 Activity.onBackPressed()，也不再派发 KeyEvent.KEYCODE_BACK
     * （见 https://developer.android.com/about/versions/16/behavior-changes-16）。
     * 因此旧版 onBackPressed() 覆写在这类设备上是**死代码**，返回键仍会走系统默认行为大退应用。
     * 官方给出的解法是迁移到受支持的返回导航 API —— OnBackPressedDispatcher /
     * OnBackPressedCallback，它在预测性返回下依然会被回调，且面向未来、无需临时开关。
     * （另一种权宜方案是在清单加 android:enableOnBackInvokedCallback="false" 退回旧模型，
     *   会失去预测性返回动画与手势，故不采用。）
     *
     * ── 为什么用 moveTaskToBack(true) 而不是 super.onBackPressed()/finish() ──
     * 用户明确反馈「返回上一级时整个应用大退」。这是 Android 默认行为：栈底按返回
     * 直接 finish() 掉 Activity → 进程被回收 → 内嵌 Node 线程一并消失，表现为「大退」。
     * 而 Android 的标准语义是：当没有更上一级可退时，按返回应把应用**退到后台**
     * （回到桌面、保留最近任务），而不是杀进程。moveTaskToBack(true) 正是该语义，
     * 参数 true 表示即使当前不是任务根 Activity 也一并移到后台。
     * 因此本 callback 内部**永不调用** super.onBackPressed()，也不做
     * setEnabled(false) + 重新 dispatch 这类「交给下级」的写法。
     *
     * 与前端契约（见 app/src/lib/back.ts，不可擅改）：
     *   window.__tavernHandleBack() 返回 'true'  → 前端已消费本次返回（已做 UI 返回），原生什么都不做；
     *   返回 'false' / 函数不存在               → 前端未消费 → 原生退到后台。
     */
    private void registerBackHandler() {
        // 参数 true = 默认启用。必须启用，否则系统不会在调用我们之前拦下返回事件，
        // 而会直接执行默认的 finish() 行为。
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                Bridge bridge = getBridge();
                WebView webView = (bridge == null) ? null : bridge.getWebView();
                if (webView == null) {
                    // WebView 尚未就绪：直接退到后台，避免走系统默认 finish() 杀进程。
                    moveTaskToBack(true);
                    return;
                }

                webView.evaluateJavascript(
                    "(window.__tavernHandleBack ? window.__tavernHandleBack() : 'false')",
                    value -> {
                        // evaluateJavascript 的回调结果是 **JSON 编码后的字符串**：
                        // JS 返回 'true' 时，回调收到的 value 实际是带双引号的 "true"。
                        // 因此不能用 "true".equals(value) 这类严格相等（永远不成立），
                        // 这里用 contains 做健壮判断（同时兼容未加引号的实现）。
                        boolean consumed = value != null && value.contains("true");
                        if (!consumed) {
                            // 前端未消费（已在栈底）→ 退到后台，而非 finish() 杀进程。
                            // 用户明确抱怨过「返回上一级特么的是大退应用」，此处不能用
                            // 系统默认返回行为。
                            moveTaskToBack(true);
                        }
                    });
                // 注：evaluateJavascript 是异步的，本方法会先返回。在
                // OnBackPressedCallback 模型下这是安全的 —— dispatcher 认为本次返回
                // 已被该 callback 消费，不会再触发默认 finish()。
            }
        });
    }

    /**
     * 实测状态栏像素高度，并把它注入为 CSS 变量 --safe-top 作为前端 env() 的兜底。
     *
     * ── 为什么拿不到值时要 return、而不是写入 0 ──────────────────────────────
     * 前端 tokens.css 将 --safe-top 定义为 env(safe-area-inset-top, 0px)，在多数设备上
     * env() 已经算对，是主路径。只有 env() 不可靠的设备才需要原生兜底。若在拿不到真实
     * insets（null）或 top<=0 时写入 '0px'，反而会把 env() 已经算好的正确值**覆盖成 0**，
     * 导致标题重新压到状态栏——这与修复目标完全相反。故拿不到值就保持沉默。
     *
     * ── 为什么必须做「物理像素 → CSS px（dp）」单位换算（2026-09-12 真机实测根因）──
     * `insets.getInsets(...).top` 给的是**物理像素**（device px），而 WebView 里的 CSS
     * `px` 是**设备独立像素（dp / CSS px）**，二者相差一个 density 倍率：
     *   px(物理) = dp(CSS) × density，即 dp(CSS) = px(物理) / density。
     * 原实现漏做换算，直接把物理像素数当成 CSS px 注入。真机（vivo，1080×2376，
     * density=480 即 3x）复验表现为「顶部空白约 3 倍」：状态栏约 28dp，其物理高度约
     * 84px，被原样写成 '84px'，而 84 CSS px 在 3x 设备上等于 84dp，于是多空出约 56dp。
     * 故此处必须除以 density 再注入。
     *
     * 用 DisplayMetrics.density（float）而非 DisplayMetrics.densityDpi/160 手算：
     * 前者已由系统算好且含小数密度（如 2.75x），最直接也最准确。这里刻意不使用
     * TypedValue.applyDimension —— 那是「dp→px」方向（dp*density），本处需要反向，
     * 除以 density 即其等价逆运算，无需额外 API。
     */
    private void applySafeAreaInsets() {
        Bridge bridge = getBridge();
        WebView webView = (bridge == null) ? null : bridge.getWebView();
        if (webView == null) {
            return;
        }

        // ViewCompat 返回的已是兼容各 API 的 WindowInsetsCompat（低版本安全），无需再手工包装
        WindowInsetsCompat insets = ViewCompat.getRootWindowInsets(webView);
        if (insets == null) {
            return;
        }
        int top = insets.getInsets(WindowInsetsCompat.Type.systemBars()).top;
        if (top <= 0) {
            // 拿不到真实高度：保持沉默，交给前端 env() 主路径
            return;
        }

        // 单位换算：insets 给的是**物理像素**，而 WebView 的 CSS `px` 是**设备独立像素（dp）**。
        // 二者相差一个 density 倍率。真机实测 bug：density=480(3x) 的设备上，未换算导致
        // 状态栏 28dp 被注入成 84 CSS px，顶部空出 3 倍高度。
        // 故必须除以 density（用 DisplayMetrics.density，它是 float，含小数密度也正确）。
        float density = getResources().getDisplayMetrics().density;
        if (density <= 0f) {
            return; // 理论不可能，但避免除零
        }
        int topDp = Math.round(top / density);

        // 行内 style 注入优先级高于样式表，可覆盖 tokens.css 里的 env() 值
        webView.evaluateJavascript(
            "document.documentElement.style.setProperty('--safe-top','" + topDp + "px')", null);
    }

    private static boolean deleteFolderRecursively(File file) {
        try {
            if (!file.exists()) {
                return true;
            }
            File[] children = file.listFiles();
            if (children != null) {
                for (File child : children) {
                    if (child.isDirectory()) {
                        deleteFolderRecursively(child);
                    } else {
                        child.delete();
                    }
                }
            }
            return file.delete();
        } catch (Exception e) {
            Log.w(TAG, "deleteFolderRecursively failed for " + file, e);
            return false;
        }
    }

    private static boolean copyAssetFolder(AssetManager assetManager, String fromAssetPath, String toPath) {
        try {
            String[] files = assetManager.list(fromAssetPath);
            boolean res = true;
            if (files == null || files.length == 0) {
                // 文件而非目录
                return copyAsset(assetManager, fromAssetPath, toPath);
            }
            new File(toPath).mkdirs();
            for (String file : files) {
                res &= copyAssetFolder(assetManager, fromAssetPath + "/" + file, toPath + "/" + file);
            }
            return res;
        } catch (Exception e) {
            Log.e(TAG, "copyAssetFolder failed: " + fromAssetPath, e);
            return false;
        }
    }

    private static boolean copyAsset(AssetManager assetManager, String fromAssetPath, String toPath) {
        InputStream in = null;
        OutputStream out = null;
        try {
            in = assetManager.open(fromAssetPath);
            new File(toPath).createNewFile();
            out = new FileOutputStream(toPath);
            copyFile(in, out);
            return true;
        } catch (Exception e) {
            Log.e(TAG, "copyAsset failed: " + fromAssetPath, e);
            return false;
        } finally {
            try { if (in != null) in.close(); } catch (IOException ignored) { }
            try { if (out != null) { out.flush(); out.close(); } } catch (IOException ignored) { }
        }
    }

    /**
     * 把已解压文件复制到持久路径（用于首启播种 config.yaml）。
     * 与 copyAsset 分开：源是普通文件而非 AssetManager 条目。
     */
    private static boolean copyFileToFile(File from, File to) {
        InputStream in = null;
        OutputStream out = null;
        try {
            in = new FileInputStream(from);
            out = new FileOutputStream(to);
            copyFile(in, out);
            return true;
        } catch (Exception e) {
            Log.e(TAG, "copyFileToFile failed: " + from + " -> " + to, e);
            return false;
        } finally {
            try { if (in != null) in.close(); } catch (IOException ignored) { }
            try { if (out != null) { out.flush(); out.close(); } } catch (IOException ignored) { }
        }
    }

    private static void copyFile(InputStream in, OutputStream out) throws IOException {
        byte[] buffer = new byte[8192];
        int read;
        while ((read = in.read(buffer)) != -1) {
            out.write(buffer, 0, read);
        }
    }
}
