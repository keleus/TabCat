import { defineConfig } from 'wxt';

// Chrome 应用商店分配的公钥，本地加载与商店版本使用同一个扩展 ID（hgblemcigdpgbhdmkhfoeicmpnhkmngg）。
const EXTENSION_KEY =
  'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA7EJXMR1Q+FUylk00djSHu1t6UHQc4n0Of4jfv8R0ntm6CQrHSlDYzXVr+23QFA2Lqzej0TEk9MDYRPSnujIzvZ7KWDZQvak/V47phPxN/b1VSl7RzJcB1o03EVc+tlPWxrC7UHaUqPJ4SsEEs8VJ7/xDsskCVPSz42IyzzXWEgZQl6ZnazBe7CNsz0F8JSWL4q+WaDWpvR9gwMmt++9pdgb0tWGC40s330QDV/nhOrc4wgz26ioWvPDQ7hdVTX3kATNApSIZNOpE3u5SYPF6qeJJWg0s3yjAvae1KS0vW4MX/nRVy+e8FqEksR2ZY65nfS9pncU+Tm5gGIngGmkoowIDAQAB';

export default defineConfig({
  outDir: 'output',
  manifest: {
    name: 'TabCat 新标签页',
    key: EXTENSION_KEY,
    icons: { 16: 'icon/16.png', 32: 'icon/32.png', 48: 'icon/48.png', 128: 'icon/128.png' },
    permissions: ['storage', 'activeTab', 'favicon', 'scripting', 'bookmarks', 'alarms'],
    host_permissions: ['http://*/*', 'https://*/*'],
    action: { default_title: '添加到 TabCat 首页' },
  },
});
