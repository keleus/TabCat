import coursera from '@iconify-icons/simple-icons/coursera';
import taobao from '@iconify-icons/simple-icons/taobao';
import canva from '@iconify-icons/simple-icons/canva';
import figma from '@iconify-icons/simple-icons/figma';
import stackoverflow from '@iconify-icons/simple-icons/stackoverflow';
import mdnwebdocs from '@iconify-icons/simple-icons/mdnwebdocs';
import gitee from '@iconify-icons/simple-icons/gitee';
import gitlab from '@iconify-icons/simple-icons/gitlab';
import gmail from '@iconify-icons/simple-icons/gmail';
import douban from '@iconify-icons/simple-icons/douban';
import github from '@iconify-icons/simple-icons/github';
import youtube from '@iconify-icons/simple-icons/youtube';
import bilibili from '@iconify-icons/simple-icons/bilibili';
import zhihu from '@iconify-icons/simple-icons/zhihu';
import notion from '@iconify-icons/simple-icons/notion';
import google from '@iconify-icons/simple-icons/google';
import baidu from '@iconify-icons/simple-icons/baidu';
import wikipedia from '@iconify-icons/simple-icons/wikipedia';

const brands = [
  ['douban.com', douban, '#007722'],
  ['mail.google.com', gmail, '#ea4335'],
  ['gitlab.com', gitlab, '#fc6d26'],
  ['gitee.com', gitee, '#c71d23'],
  ['developer.mozilla.org', mdnwebdocs, '#222222'],
  ['stackoverflow.com', stackoverflow, '#f58025'],
  ['figma.com', figma, '#5551ff'],
  ['canva.com', canva, '#00aabb'],
  ['taobao.com', taobao, '#ff5000'],
  ['coursera.org', coursera, '#0056d2'],

  ['github.com', github, '#24292f'], ['youtube.com', youtube, '#ff0033'],
  ['bilibili.com', bilibili, '#fb7299'], ['zhihu.com', zhihu, '#1772f6'],
  ['notion.so', notion, '#ffffff', '#191919'], ['notion.com', notion, '#ffffff', '#191919'],
  ['google.com', google, '#4285f4'], ['baidu.com', baidu, '#2932e1'],
  ['wikipedia.org', wikipedia, '#ffffff', '#262626'],
];

// Locally bundled brand artwork, with a complete tile background like a launcher.
export function brandIcon(url) {
  let host; try { host = new URL(url).hostname; } catch { return ''; }
  const brand = brands.find(([domain]) => host === domain || host.endsWith(`.${domain}`));
  if (!brand) return '';
  const [, icon, background, foreground = '#ffffff'] = brand;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="${background}"/><svg x="18" y="18" width="64" height="64" viewBox="0 0 ${icon.width || 24} ${icon.height || 24}" color="${foreground}">${icon.body}</svg></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}
