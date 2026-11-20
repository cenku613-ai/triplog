import { describe, expect, it } from 'vitest';
import { blobToDataUrl, dataUrlToBlob, humanSize } from './images';

/**
 * rasterize() 要畫布，node 環境跑不了，這裡只測備份用的 base64 來回：
 * 匯出時照片以 data URL 存進 JSON，拆錯 mime 或解錯位元組，備份檔就會悄悄壞掉。
 */
const PNG_1PX =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';

describe('圖片與 data URL 來回', () => {
  it('還原後再編回去，資料一模一樣', async () => {
    const blob = dataUrlToBlob(PNG_1PX);
    expect(blob.type).toBe('image/png');
    // 兩條路都要走得到：瀏覽器用 FileReader，node 用 btoa 兜底
    expect(await blobToDataUrl(blob)).toBe(PNG_1PX);
  });

  it('沒有標明 mime 時退回 image/jpeg', () => {
    const blob = dataUrlToBlob('data:,hello');
    expect(blob.type).toBe('image/jpeg');
  });

  it('非 base64 的 data URL 當作 URI 編碼的文字還原', async () => {
    const blob = dataUrlToBlob('data:text/plain,hi%20there');
    expect(blob.type).toBe('text/plain');
    expect(await blob.text()).toBe('hi there');
  });

  it('人類可讀的容量單位', () => {
    expect(humanSize(512)).toBe('512 B');
    expect(humanSize(2048)).toBe('2 KB');
    expect(humanSize(3.5 * 1024 * 1024)).toBe('3.5 MB');
  });
});
