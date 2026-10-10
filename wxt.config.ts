import { defineConfig } from 'wxt';

export default defineConfig({
  manifest: {
    name: 'TabCat 新标签页',
    permissions: ['storage', 'activeTab', 'favicon', 'scripting', 'bookmarks', 'alarms'],
    host_permissions: ['http://*/*', 'https://*/*'],
    action: { default_title: '添加到 TabCat 首页' },
  },
});
