import { defineConfig } from 'wxt';

export default defineConfig({
  manifest: {
    name: 'TabCat 新标签页',
    icons: { 16: 'icon/16.png', 32: 'icon/32.png', 48: 'icon/48.png', 128: 'icon/128.png' },
    permissions: ['storage', 'activeTab', 'favicon', 'scripting', 'bookmarks', 'alarms'],
    host_permissions: ['http://*/*', 'https://*/*'],
    action: { default_title: '添加到 TabCat 首页' },
  },
});
