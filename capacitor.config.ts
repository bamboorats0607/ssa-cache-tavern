import type { CapacitorConfig } from '@capacitor/cli';

/**
 * tavern 跨端壳（Capacitor）配置。
 *
 * 形态终裁 (b)：壳自带 web 资产 + 用户在设置里填写本地/局域网后端地址。
 * 因此此处 **绝不使用 `server.url` 指向远端**（X7：会令 Capacitor.isNativePlatform() 返回 false，
 * 且触碰维护者明确不推荐的「用 Capacitor 加载外部站点」红线）。
 */
const config: CapacitorConfig = {
  appId: 'dev.tavern.shell',
  appName: 'Tavern',
  // 确定性构建物：app/dist（由 app 的 vite build 产出）
  webDir: 'app/dist',

  // 不指定 server.url ⇒ 壳从内置 web 资产启动。
  // androidScheme 保持默认 'https' ⇒ 页面 origin = https://localhost（Capacitor 6+ 行为，X1）。
  server: {
    androidScheme: 'https',
  },

  android: {
    // B3 选定通道：放行 WebView 混合内容（https://localhost → http://LAN-IP:PORT）。
    // 该开关由 Capacitor 自身消费：Bridge.java:593-595
    //   if (config.isMixedContentAllowed()) settings.setMixedContentMode(MIXED_CONTENT_ALWAYS_ALLOW);
    allowMixedContent: true,
  },

  // 注意：此处刻意 **不启用** CapacitorHttp 插件。
  // 原因见 B3 判定：CapacitorHttp 会把跨域响应整体缓冲（native-bridge.js:532 `call.resolve` →
  // `new Response(data, ...)`），破坏 EventSource / ReadableStream 流式响应，
  // 而本项目聊天依赖 `response.body.pipeThrough(...)` + `getReader()` 的真流式。
};

export default config;
