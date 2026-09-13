import { mount } from 'svelte'
import './styles/tokens.css'
import './styles/base.css'
import { applyTheme, loadTheme } from './stores/theme.svelte'
import { installBackBridge } from './lib/back'
import App from './App.svelte'

// 首屏应用已保存主题（不加过渡，避免闪一下）
applyTheme(loadTheme(), false)

// 安装返回键桥接入口（幂等）；原生通过 window.__tavernHandleBack 逐级询问
installBackBridge()

const app = mount(App, {
  target: document.getElementById('app')!,
})

export default app
