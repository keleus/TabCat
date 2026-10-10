import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSuggestions, searchProvider, suggestionUrl, engineIcon } from '../lib/search.js';

test('suggestions are selected by the engine URL and query is encoded', () => {
  assert.equal(searchProvider({ id: 'google', url: 'https://example.com/?q=%s' }), '');
  assert.equal(searchProvider({ url: 'https://cn.bing.com/search?q=%s' }), 'bing');
  assert.equal(suggestionUrl('other', 'test'), '');
  assert.match(suggestionUrl('google', '猫 & dog'), /q=%E7%8C%AB%20%26%20dog$/);
  assert.equal(engineIcon({ url: 'https://www.baidu.com/s?wd=%s' }), '/catalog/baidu-favicon.png');
});

test('suggestion parsers handle JSON and Baidu JSONP as data without executing code', () => {
  assert.deepEqual(parseSuggestions('google', '["q",["one","two","one",7,"",null]]'), ['one', 'two']);
  assert.deepEqual(parseSuggestions('bing', '["q",["必应测试"]]'), ['必应测试']);
  assert.deepEqual(parseSuggestions('baidu', 'tabcat({q:"x",p:false,s:["测试","a\\\"b","c]d"]});'), ['测试', 'a"b', 'c]d']);
  assert.deepEqual(parseSuggestions('baidu', 'alert("do not run")'), []);
});
