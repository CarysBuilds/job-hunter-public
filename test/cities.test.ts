import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { cityCodeFor, cityNameFromBossCode, normalizeCityName } from '../src/cities.js';

describe('招聘平台城市匹配', () => {
  it('同一个城市转换为三个平台各自的编码', () => {
    assert.equal(cityCodeFor('boss', '北京'), '101010100');
    assert.equal(cityCodeFor('liepin', '北京'), '010');
    assert.equal(cityCodeFor('zhaopin', '北京'), '530');
    assert.equal(cityCodeFor('liepin', '深圳'), '050090');
    assert.equal(cityCodeFor('zhaopin', '深圳'), '765');
  });

  it('兼容带“市”的名称和旧 BOSS 城市码', () => {
    assert.equal(normalizeCityName(' 上海市 '), '上海');
    assert.equal(cityNameFromBossCode('101280600'), '深圳');
  });

  it('平台未支持的城市明确报错而不是回落到深圳', () => {
    assert.throws(() => cityCodeFor('liepin', '武汉'), /暂不支持城市“武汉”/);
  });
});
