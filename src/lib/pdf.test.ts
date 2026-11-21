import { describe, expect, it } from 'vitest';
import type { Category, DayItem, Expense, Trip } from '../db/types';
import { setLang } from '../i18n';
import { summarize } from './stats';
import { DEFAULT_SECTIONS, buildPrintHtml, esc, type PdfSections, type PrintInput } from './pdf';

// 文件內容跟著介面語言走，測試綁在繁中（最後一個 case 會自己換回 en）
setLang('zh-Hant');

const trip: Trip = {
  id: 't1',
  name: '京都',
  startDate: '2026-11-01',
  endDate: '2026-11-02',
  baseCurrency: 'TWD',
  budget: 5000,
  color: '#0f766e',
  notes: '秋天的祕密行程',
  companions: ['小安', '阿合'],
  archived: false,
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-01T00:00:00.000Z',
};

const cats: Category[] = [
  { id: 'c-food', kind: 'expense', key: 'food', label: '餐飲', color: '#e07a3f', order: 1, builtin: true },
  { id: 'c-stay', kind: 'expense', key: 'stay', label: '住宿', color: '#7c5cd6', order: 2, builtin: true },
];

const items: DayItem[] = [
  {
    id: 'i1',
    tripId: 't1',
    date: '2026-11-01',
    kind: 'food',
    title: '一保堂茶鋪',
    startTime: '09:00',
    endTime: '10:00',
    location: '中京區',
    note: '',
    order: 1,
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
  },
  {
    id: 'i2',
    tripId: 't1',
    date: '2026-11-02',
    kind: 'stay',
    title: '東急 Stay 入住',
    order: 1,
    createdAt: '2026-11-02T00:00:00.000Z',
    updatedAt: '2026-11-02T00:00:00.000Z',
  },
];

function exp(p: Partial<Expense>): Expense {
  return {
    id: 'e1',
    tripId: 't1',
    dayItemId: 'i1',
    date: '2026-11-01',
    amount: 1200,
    currency: 'TWD',
    rateToBase: 1,
    baseAmount: 1200,
    category: 'c-food',
    payee: '小安',
    note: '',
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
    ...p,
  };
}

const expenses: Expense[] = [
  exp({ id: 'e1' }),
  exp({ id: 'e2', dayItemId: 'i2', date: '2026-11-02', amount: 800, currency: 'JPY', rateToBase: 0.2, baseAmount: 160, category: 'c-stay', payee: '阿合' }),
];

function input(overrides: Partial<PrintInput> = {}): PrintInput {
  return {
    trip,
    items,
    expenses,
    categories: cats,
    summary: summarize(trip, expenses, cats, items),
    sections: { ...DEFAULT_SECTIONS },
    photos: [],
    mapImage: null,
    ...overrides,
  };
}

function off(sections: PdfSections, key: keyof PdfSections): PdfSections {
  return { ...sections, [key]: false };
}

describe('esc', () => {
  it('把 HTML 特殊字元全部轉掉，屬性內容也安全', () => {
    expect(esc('<b>&"\'')).toBe('&lt;b&gt;&amp;&quot;&#39;');
    expect(esc(null)).toBe('');
    expect(esc(12)).toBe('12');
  });
});

describe('buildPrintHtml', () => {
  it('是一份完整的可列印文件，含 A4 列印樣式', () => {
    const html = buildPrintHtml(input());
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('<html lang="zh-Hant">');
    expect(html).toContain('@page');
    expect(html).toContain('window.print()');
    expect(html).toContain('<title>京都 — TripLog</title>');
  });

  it('封面帶出名稱、天數、同行者與合計', () => {
    const html = buildPrintHtml(input());
    expect(html).toContain('<header class="cover">');
    expect(html).toContain('小安');
    expect(html).toContain('秋天的祕密行程');
    // 1200 + 800 JPY×0.2 = 1360 TWD
    expect(html).toContain('1,360');
  });

  it('五個區塊全開時，行程、明細、圖表、地圖、照片都在', () => {
    const html = buildPrintHtml(
      input({
        mapImage: 'data:image/png;base64,AAAA',
        photos: [
          { id: 'p1', dayItemId: 'i1', dataUrl: 'data:image/jpeg;base64,BBBB', caption: '本店', artist: 'Alice', license: 'CC BY-SA 4.0' },
        ],
      }),
    );
    expect(html).toContain('一保堂茶鋪');
    expect(html).toContain('<table>');
    expect(html).toContain('viewBox="0 0 100 86"'); // 每日長條圖
    expect(html).toContain('viewBox="0 0 42 42"'); // 分類圓環
    expect(html).toContain('data:image/png;base64,AAAA');
    expect(html).toContain('data:image/jpeg;base64,BBBB');
    expect(html).toContain('Alice');
  });

  it('關掉的區塊就不會出現在文件裡', () => {
    const all = { ...DEFAULT_SECTIONS };
    expect(buildPrintHtml(input({ sections: off(all, 'itinerary') }))).not.toContain('class="day-head"');
    expect(buildPrintHtml(input({ sections: off(all, 'expenses') }))).not.toContain('class="total"');
    expect(buildPrintHtml(input({ sections: off(all, 'stats') }))).not.toContain('viewBox="0 0 42 42"');
    expect(
      buildPrintHtml(
        input({
          sections: off(all, 'photos'),
          photos: [{ id: 'p1', dataUrl: 'data:image/jpeg;base64,BBBB' }],
        }),
      ),
    ).not.toContain('<figure>');
    expect(
      buildPrintHtml(input({ sections: off(all, 'map'), mapImage: 'data:image/png;base64,AAAA' })),
    ).not.toContain('data:image/png;base64,AAAA');
  });

  it('開著地圖但擷取失敗時，講清楚而不是留一個空白區塊', () => {
    const html = buildPrintHtml(input({ mapImage: null }));
    expect(html).toContain('地圖擷取失敗');
    expect(html).not.toContain('class="mapshot"');
  });

  it('使用者輸入會被逃脫，不會變成可執行的 HTML', () => {
    const evil = '<img src=x onerror=alert(1)>';
    const html = buildPrintHtml(
      input({
        trip: { ...trip, name: `京都<script>${evil}</script>` },
        items: [{ ...items[0], title: evil, location: `"quoted"`, note: `a & b` }],
        expenses: [exp({ id: 'e1', note: evil, payee: `<b>${evil}</b>` })],
        photos: [{ id: 'p1', dataUrl: 'data:image/jpeg;base64,BBBB', caption: evil }],
      }),
    );
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('&quot;quoted&quot;');
    expect(html).toContain('a &amp; b');
  });

  it('空白資料也能生出文件，各區塊顯示「沒有內容」而不是壞掉', () => {
    const emptyTrip: Trip = { ...trip, budget: null, companions: [], notes: '' };
    const html = buildPrintHtml(
      input({ trip: emptyTrip, items: [], expenses: [], photos: [], summary: summarize(emptyTrip, [], cats, []) }),
    );
    expect(html).toContain('（沒有內容）');
    expect(html).toContain('</html>');
    expect(html).not.toContain('>null<');
  });

  it('切換成英文時文件的 lang 與標題跟著換', () => {
    setLang('en');
    const html = buildPrintHtml(input());
    expect(html).toContain('<html lang="en">');
    expect(html).toContain('Travel record');
    setLang('zh-Hant');
  });
});
