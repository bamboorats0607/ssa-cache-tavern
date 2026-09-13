import { svelte } from '@sveltejs/vite-plugin-svelte'
import { defineConfig } from 'vite'

// https://vite.dev/config/
// 确定性构建配置（S3 / T-1.14）：
// 1) 显式声明 entry / chunk / asset 命名模式，全部基于内容 hash（[hash]），
//    相同输入 => 相同文件名与内容；不使用时间戳、随机数等非确定成分。
// 2) 关闭 sourcemap，避免额外产物影响“两次构建 diff==0”判定。
// Vite 8 底层为 Rolldown，输出目录命名键位于 build.rolldownOptions.output。
export default defineConfig({
  plugins: [svelte()],
  build: {
    sourcemap: false,
    // 每次构建前清空 dist，避免历史 hash 产物堆积（会连带污染 cap sync 同步到
    // Android assets 的 web 资产，无谓增大 APK）
    emptyOutDir: true,
    // 固定压缩目标，避免环境差异影响产物字节
    target: 'es2022',
    rolldownOptions: {
      output: {
        entryFileNames: 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
})
