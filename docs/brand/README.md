# TabCat 猫猫头像

<img src="../../public/icon/tabcat.svg" width="256" height="256" alt="TabCat 猫猫头像" />

## 设计

这份猫猫简笔画直接使用 SVG 路径和椭圆绘制，没有嵌入位图，也没有复制或描摹现成品牌的 Logo。

造型采用黑白配色和圆润线条，保留双耳、圆眼睛、小鼻子、微笑和胡须，去掉渐变、彩色填充和额纹。脸部以白色衬底，外侧透明，方便在深浅背景中辨认；简洁的五官适合缩小为浏览器工具栏图标。

## 文件与使用

- [SVG 源文件](../../public/icon/tabcat.svg)：`viewBox="0 0 256 256"`，可直接编辑形状与颜色，用于产品介绍、页面图标和收藏弹窗。
- PNG 图标：[16 px](../../public/icon/16.png)、[32 px](../../public/icon/32.png)、[48 px](../../public/icon/48.png)、[128 px](../../public/icon/128.png)。全部从同一 SVG 导出，供浏览器扩展清单使用。
- 之前的生成图片及临时图标已由这份 SVG 设计替换。

## 重新导出

```sh
npm install
npx playwright install chromium
npm run icons
npm run build
```

导出脚本为 [scripts/render-brand-icons.mjs](../../scripts/render-brand-icons.mjs)，使用 Chromium 渲染 SVG，保留透明背景，不依赖在线服务。也可通过 `TABCAT_CHROMIUM_PATH` 指定已有的 Chromium 可执行文件。

## 许可与署名

Copyright © 2026 keleus <jen.hs@outlook.com>

本项目的猫猫 SVG 及其 PNG 导出采用 [MIT License](../../LICENSE)。网站快捷方式中用于识别对应网站的第三方图标仍保留各自的来源与许可，与 TabCat 自身的品牌头像分开记录。
