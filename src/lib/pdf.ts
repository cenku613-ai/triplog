import { formatAmount } from '../db/currency';
import type { Category, DayItem, Expense, Trip } from '../db/types';
import { t, tRaw, lang } from '../i18n';
import { dayLabel, formatDuration, prettyDate } from './dates';
import { categoryLabel, expenseLabel } from './labels';
import type { TripSummary } from './stats';

/**
 * 產生「可列印」的 HTML 文件，存 PDF 由瀏覽器的列印對話框完成。
 *
 * 為什麼走這條路而不是 jsPDF + html2canvas：多邊形文字在 PDF 裡還是可選取、可搜尋的
 * 向量字，繁中／日文不需要另外掛 CJK font（掛了 bundle 立刻 +2 MB），而且照片直接
 * 用 <img> 引用就好。代價是要按兩次按鈕（產生 → 儲存為 PDF），對旅行結算這種
 * 低頻動作剛好。
 *
 * 圖表一律用 inline SVG 而不是 <canvas>／CSS background：列印時「背景圖形」沒勾
 * 也照樣出圖，這是最多人踩的雷。
 */

export type PdfSections = {
  itinerary: boolean;
  expenses: boolean;
  stats: boolean;
  photos: boolean;
  map: boolean;
};

export const DEFAULT_SECTIONS: PdfSections = {
  itinerary: true,
  expenses: true,
  stats: true,
  photos: true,
  map: true,
};

export type PrintPhoto = {
  id: string;
  dayItemId?: string | null;
  dataUrl: string;
  caption?: string;
  artist?: string;
  license?: string;
  creditUrl?: string;
};

export type PrintInput = {
  trip: Trip;
  items: DayItem[];
  expenses: Expense[];
  categories: Category[];
  summary: TripSummary;
  sections: PdfSections;
  photos?: PrintPhoto[];
  mapImage?: string | null;
};

export function esc(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );
}

const CSS = `
:root { color-scheme: light; }
* { box-sizing: border-box; }
body {
  margin: 0; padding: 24px 16px 40px;
  background: #f2f4f7; color: #16202b;
  font-family: -apple-system, BlinkMacSystemFont, "PingFang TC", "Noto Sans CJK TC",
    "Microsoft JhengHei", "Segoe UI", Roboto, system-ui, sans-serif;
  font-size: 13px; line-height: 1.55;
}
.doc {
  max-width: 186mm; margin: 0 auto; background: #fff; padding: 14mm 13mm 16mm;
  box-shadow: 0 8px 28px rgba(16, 32, 43, .12);
}
h1 { font-size: 25px; line-height: 1.25; margin: 0 0 4px; letter-spacing: .2px; }
h2 { font-size: 15px; margin: 0 0 10px; padding-bottom: 6px; border-bottom: 2px solid #16202b; }
h3 { font-size: 13px; margin: 16px 0 6px; }
section { margin-top: 22px; }
a { color: #1d4ed8; text-decoration: none; }
.tiny { font-size: 11px; color: #5b6674; }
.row { display: flex; gap: 14px; flex-wrap: wrap; }
.cover { border-bottom: 1px solid #d7dce3; padding-bottom: 14px; }
.swatch { display: inline-block; width: 12px; height: 12px; border-radius: 3px; margin-right: 7px; }
.metrics { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 12px; }
.metric { flex: 1 1 120px; border: 1px solid #d7dce3; border-radius: 8px; padding: 8px 10px; }
.metric .k { font-size: 10.5px; text-transform: uppercase; letter-spacing: .4px; color: #5b6674; }
.metric .v { font-size: 17px; font-weight: 700; margin-top: 2px; }
.day { margin-top: 16px; break-inside: avoid; }
.day-head { display: flex; align-items: baseline; gap: 8px; border-left: 4px solid #0f766e; padding-left: 8px; }
.day-head b { font-size: 14px; }
.item { padding: 8px 0 8px 12px; border-bottom: 1px dashed #e3e7ec; break-inside: avoid; }
.item:last-child { border-bottom: 0; }
.item .top { display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; }
.item .ttl { font-weight: 650; font-size: 13.5px; }
.kind { font-size: 10.5px; border: 1px solid #cfd6de; border-radius: 999px; padding: 1px 7px; color: #44505f; }
.when { font-variant-numeric: tabular-nums; color: #44505f; font-size: 12px; }
.meta { color: #5b6674; font-size: 11.5px; margin-top: 2px; }
table { width: 100%; border-collapse: collapse; margin-top: 6px; }
th, td { text-align: left; padding: 5px 6px; border-bottom: 1px solid #e6eaef; vertical-align: top; }
th { font-size: 10.5px; text-transform: uppercase; letter-spacing: .4px; color: #5b6674; border-bottom: 1.5px solid #16202b; }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
tr.total td { font-weight: 700; border-top: 1.5px solid #16202b; border-bottom: 0; }
figure { margin: 0; break-inside: avoid; }
.gallery { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 10px; margin-top: 8px; }
.gallery img { width: 100%; height: 118px; object-fit: cover; border-radius: 6px; display: block; }
figcaption { font-size: 10.5px; color: #5b6674; margin-top: 3px; }
.mapshot img { width: 100%; border-radius: 8px; display: block; border: 1px solid #d7dce3; }
.legend { display: flex; gap: 12px; flex-wrap: wrap; margin-top: 8px; font-size: 11px; }
.legend i { display: inline-block; width: 9px; height: 9px; border-radius: 50%; margin-right: 4px; }
.toolbar {
  position: sticky; top: 0; z-index: 2; max-width: 186mm; margin: 0 auto 16px;
  display: flex; gap: 10px; align-items: center; flex-wrap: wrap;
  background: #16202b; color: #fff; padding: 10px 14px; border-radius: 10px; font-size: 12.5px;
}
.toolbar button { font: inherit; padding: 6px 12px; border-radius: 7px; border: 1px solid #46566a; background: #22303f; color: #fff; cursor: pointer; }
.toolbar button.primary { background: #0f766e; border-color: #0f766e; font-weight: 700; }
.toolbar .hint { color: #b9c4d1; }
@media print {
  body { background: #fff; padding: 0; font-size: 11.5px; }
  .doc { max-width: none; box-shadow: none; padding: 0; }
  .toolbar { display: none; }
  section { margin-top: 16px; }
  h1 { font-size: 22px; }
}
@page { size: A4; margin: 15mm 13mm; }
`;

/** 每日長條：SVG 畫，列印不靠背景圖形也有色 */
function barsSvg(rows: { label: string; amount: number; color?: string }[], base: string): string {
  const max = Math.max(1, ...rows.map((r) => r.amount));
  const w = 100 / Math.max(1, rows.length);
  const parts = rows.map((r, i) => {
    const h = Math.max(1, (r.amount / max) * 70);
    const x = i * w;
    return (
      `<rect x="${x.toFixed(2)}%" y="${(74 - h).toFixed(1)}" width="${(w * 0.72).toFixed(2)}%" height="${h.toFixed(1)}" rx="1.5" fill="${esc(r.color ?? '#0f766e')}"><title>${esc(r.label)}: ${esc(formatAmount(r.amount, base))}</title></rect>` +
      `<text x="${(x + w * 0.36).toFixed(2)}%" y="82" font-size="5" text-anchor="middle" fill="#5b6674">${esc(r.label)}</text>`
    );
  });
  return `<svg viewBox="0 0 100 86" preserveAspectRatio="none" style="width:100%;height:96px" role="img">${parts.join('')}</svg>`;
}

/** 分類占比環：stroke-dasharray 疊段，比 conic-gradient 可靠 */
function ringSvg(segs: { label: string; amount: number; color: string }[], base: string): string {
  const total = segs.reduce((s, x) => s + x.amount, 0);
  if (total <= 0) return '';
  const R = 15.9155; // 週長 = 100，方便把占比直接當成 dasharray
  let offset = 25; // 從 12 點方向開始
  const circles = segs
    .filter((s) => s.amount > 0)
    .map((s) => {
      const pct = (s.amount / total) * 100;
      const el = `<circle r="${R}" cx="21" cy="21" fill="none" stroke="${esc(s.color)}" stroke-width="8" stroke-dasharray="${pct.toFixed(2)} ${(100 - pct).toFixed(2)}" stroke-dashoffset="${offset.toFixed(2)}"><title>${esc(s.label)} ${pct.toFixed(1)}%</title></circle>`;
      offset -= pct;
      return el;
    })
    .join('');
  const legend = segs
    .filter((s) => s.amount > 0)
    .map(
      (s) =>
        `<span><i style="background:${esc(s.color)}"></i>${esc(s.label)} · ${esc(formatAmount(s.amount, base))} (${((s.amount / total) * 100).toFixed(1)}%)</span>`,
    )
    .join('');
  return `<div class="row" style="align-items:center"><svg viewBox="0 0 42 42" style="width:112px;height:112px;flex:0 0 112px"><circle r="${R}" cx="21" cy="21" fill="none" stroke="#eef1f5" stroke-width="8"/>${circles}<text x="21" y="20.4" font-size="4.4" text-anchor="middle" fill="#5b6674">${esc(base)}</text><text x="21" y="25.4" font-size="5.4" font-weight="700" text-anchor="middle">${esc(formatAmount(total, base))}</text></svg><div class="legend" style="flex-direction:column;gap:4px">${legend}</div></div>`;
}

function kindLabel(kind: DayItem['kind']): string {
  return tRaw(`cat.${kind}`);
}

function itemsByDay(items: DayItem[]): Map<string, DayItem[]> {
  const map = new Map<string, DayItem[]>();
  for (const item of [...items].sort((a, b) => a.date.localeCompare(b.date) || a.order - b.order)) {
    const arr = map.get(item.date) ?? [];
    arr.push(item);
    map.set(item.date, arr);
  }
  return map;
}

function itinerarySection(input: PrintInput): string {
  const { trip, items, expenses, categories, summary } = input;
  const catMap = new Map(categories.map((c) => [c.id, c]));
  const byDay = itemsByDay(items);
  const dayNumber = new Map<string, number>();
  let day = 0;
  for (const date of byDay.keys()) dayNumber.set(date, ++day);

  const blocks = [...byDay.entries()].map(([date, rows]) => {
    const n = dayNumber.get(date) ?? 1;
    const body = rows
      .map((item) => {
        const linked = expenses.filter((e) => e.dayItemId === item.id);
        const amount = summary.byDayItem[item.id] ?? 0;
        const when = formatDuration(item.startTime, item.endTime);
        const note = item.note?.trim();
        const place = item.location?.trim();
        return (
          '<div class="item"><div class="top">' +
          (when ? `<span class="when">${esc(when)}</span>` : '') +
          `<span class="ttl">${esc(item.title)}</span>` +
          `<span class="kind">${esc(kindLabel(item.kind))}</span>` +
          (linked.length
            ? `<span class="tiny">${esc(t('item.linkedBadge', { n: linked.length, amt: formatAmount(amount, trip.baseCurrency) }))}</span>`
            : '') +
          '</div>' +
          (place ? `<div class="meta">${esc(place)}</div>` : '') +
          (note ? `<div class="meta">${esc(note)}</div>` : '') +
          (linked.length
            ? `<div class="meta">${linked
                .map(
                  (e) =>
                    `${esc(e.date)} · ${esc(expenseLabel(e, catMap.get(e.category)))} · ${esc(
                      formatAmount(e.amount, e.currency),
                    )}`,
                )
                .join(' / ')}</div>`
            : '') +
          '</div>'
        );
      })
      .join('');
    return (
      `<div class="day"><div class="day-head"><b>${esc(t('print.dayHead', { n, date: prettyDate(date, { withYear: true }) }))}</b>` +
      `<span class="tiny">${esc(t('common.countItems', { n: rows.length }))}</span></div>${body}</div>`
    );
  });

  if (!blocks.length) return `<p class="tiny">${esc(t('print.emptySection'))}</p>`;
  return blocks.join('');
}

function expensesSection(input: PrintInput): string {
  const { trip, expenses, categories, items } = input;
  if (!expenses.length) return `<p class="tiny">${esc(t('print.emptySection'))}</p>`;
  const catMap = new Map(categories.map((c) => [c.id, c]));
  const itemMap = new Map(items.map((i) => [i.id, i]));
  const rows = [...expenses]
    .sort((a, b) => a.date.localeCompare(b.date) || a.createdAt.localeCompare(b.createdAt))
    .map((e) => {
      const item = e.dayItemId ? itemMap.get(e.dayItemId) : undefined;
      const label = item?.title ?? t('item.unlinked');
      return (
        '<tr>' +
        `<td>${esc(prettyDate(e.date))}</td>` +
        `<td>${esc(label)}${e.note ? `<div class="tiny">${esc(e.note)}</div>` : ''}</td>` +
        `<td>${esc(catMap.get(e.category) ? categoryLabel(catMap.get(e.category)) : t('common.uncategorized'))}</td>` +
        `<td class="num">${esc(formatAmount(e.amount, e.currency))}${e.currency !== trip.baseCurrency ? `<div class="tiny">${esc(t('print.rate', { rate: e.rateToBase }))}</div>` : ''}</td>` +
        `<td class="num">${esc(formatAmount(e.baseAmount, trip.baseCurrency))}</td>` +
        `<td>${esc(e.payee ?? '')}</td>` +
        '</tr>'
      );
    })
    .join('');
  return (
    '<table><thead><tr>' +
    `<th>${esc(t('print.th.date'))}</th><th>${esc(t('print.th.item'))}</th><th>${esc(t('common.category'))}</th>` +
    `<th class="num">${esc(t('common.amount'))}</th><th class="num">${esc(t('stats.colBase', { code: trip.baseCurrency }))}</th>` +
    `<th>${esc(t('print.th.payee'))}</th>` +
    `</tr></thead><tbody>${rows}<tr class="total"><td colspan="4">${esc(t('print.total'))}</td>` +
    `<td class="num">${esc(formatAmount(input.summary.totalBase, trip.baseCurrency))}</td><td></td></tr></tbody></table>` +
    `<p class="tiny">${esc(t('stats.rateNote'))}</p>`
  );
}

function statsSection(input: PrintInput): string {
  const { trip, summary } = input;
  const base = trip.baseCurrency;
  if (!summary.expenseCount) return `<p class="tiny">${esc(t('stats.noData'))}</p>`;
  const metrics =
    '<div class="metrics">' +
    `<div class="metric"><div class="k">${esc(t('print.cover.spent'))}</div><div class="v">${esc(formatAmount(summary.totalBase, base))}</div></div>` +
    (summary.budget
      ? `<div class="metric"><div class="k">${esc(t('print.cover.budget'))}</div><div class="v">${esc(formatAmount(summary.budget, base))}</div><div class="tiny">${esc(
          summary.remaining !== null && summary.remaining < 0
            ? t('stats.over', { amt: formatAmount(-summary.remaining, base) })
            : t('stats.left', { amt: formatAmount(summary.remaining ?? 0, base) }),
        )}</div></div>`
      : '') +
    `<div class="metric"><div class="k">${esc(t('print.cover.perDay'))}</div><div class="v">${esc(formatAmount(summary.perDayAverage, base))}</div></div>` +
    (summary.maxDay && summary.maxDay.count
      ? `<div class="metric"><div class="k">${esc(t('stats.maxDay'))}</div><div class="v">${esc(formatAmount(summary.maxDay.amount, base))}</div><div class="tiny">${esc(dayLabel(dayIndexOf(trip, summary.maxDay.date)))} · ${esc(prettyDate(summary.maxDay.date))}</div></div>`
      : '') +
    '</div>';

  const daily = summary.days.filter((d) => d.count > 0);
  const dayBlock = daily.length
    ? `<h3>${esc(t('stats.daily'))}</h3>${barsSvg(
        daily.map((d) => ({ label: prettyDate(d.date).slice(0, 5), amount: d.amount })),
        base,
      )}`
    : '';

  const catBlock = summary.byCategory.length
    ? `<h3>${esc(t('stats.byCategory'))}</h3>${ringSvg(summary.byCategory, base)}`
    : '';

  const curRows = summary.byCurrency
    .map(
      (c) =>
        `<tr><td>${esc(c.label)}</td><td class="num">${esc(c.count)}</td><td class="num">${esc(formatAmount(c.amount, c.key))}</td></tr>`,
    )
    .join('');
  const curBlock = summary.byCurrency.length
    ? `<h3>${esc(t('stats.byCurrency'))}</h3><table><thead><tr><th>${esc(t('stats.colCurrency'))}</th><th class="num">${esc(t('stats.colCount'))}</th><th class="num">${esc(t('stats.colOriginal'))}</th></tr></thead><tbody>${curRows}</tbody></table>`
    : '';

  const payerRows = summary.byPayer
    .map(
      (p) =>
        `<tr><td>${esc(p.key)}</td><td class="num">${esc(p.count)}</td><td class="num">${esc(formatAmount(p.amount, base))}</td></tr>`,
    )
    .join('');
  const payerBlock = summary.byPayer.length
    ? `<h3>${esc(t('stats.byPayer'))}</h3><table><thead><tr><th>${esc(t('print.th.payee'))}</th><th class="num">${esc(t('stats.colCount'))}</th><th class="num">${esc(t('stats.colBase', { code: base }))}</th></tr></thead><tbody>${payerRows}</tbody></table><p class="tiny">${esc(t('stats.payerNote'))}</p>`
    : '';

  return metrics + dayBlock + catBlock + curBlock + payerBlock;
}

function dayIndexOf(trip: Trip, date: string): number {
  const ms = Date.parse(`${date}T00:00:00`) - Date.parse(`${trip.startDate}T00:00:00`);
  return Number.isFinite(ms) ? Math.floor(ms / 86400000) + 1 : 1;
}

function mapSection(input: PrintInput): string {
  if (!input.mapImage) {
    return `<p class="tiny">${esc(t('print.mapMissing'))}</p>`;
  }
  return (
    `<div class="mapshot"><img src="${input.mapImage}" alt="${esc(t('print.mapTitle'))}"></div>` +
    `<p class="tiny">${esc(t('map.attribution'))}</p>`
  );
}

function photosSection(input: PrintInput): string {
  const photos = input.photos ?? [];
  if (!photos.length) return `<p class="tiny">${esc(t('print.emptySection'))}</p>`;
  const cells = photos
    .map((p) => {
      const credit = p.artist
        ? `<div>${esc(t('print.photoCredit', { artist: p.artist, license: p.license ?? '' }))}</div>`
        : '';
      const caption = p.caption ? `<div>${esc(p.caption)}</div>` : '';
      return `<figure><img src="${p.dataUrl}" alt="${esc(p.caption ?? '')}" loading="eager"><figcaption>${caption}${credit}</figcaption></figure>`;
    })
    .join('');
  return `<p class="tiny">${esc(t('photo.count', { n: photos.length }))}</p><div class="gallery">${cells}</div>`;
}

function cover(input: PrintInput): string {
  const { trip, summary, items, expenses } = input;
  const days = dayIndexOf(trip, trip.endDate);
  const companionText = trip.companions?.length
    ? `<div class="tiny">${esc(t('print.cover.companions', { names: trip.companions.join('、') }))}</div>`
    : '';
  const metrics =
    '<div class="metrics">' +
    `<div class="metric"><div class="k">${esc(t('detail.itemsTile'))}</div><div class="v">${items.length}</div></div>` +
    `<div class="metric"><div class="k">${esc(t('detail.expensesTile'))}</div><div class="v">${expenses.length}</div></div>` +
    `<div class="metric"><div class="k">${esc(t('print.cover.spent'))}</div><div class="v">${esc(formatAmount(summary.totalBase, trip.baseCurrency))}</div></div>` +
    (summary.budget
      ? `<div class="metric"><div class="k">${esc(t('print.cover.budget'))}</div><div class="v">${esc(formatAmount(summary.budget, trip.baseCurrency))}</div></div>`
      : '') +
    '</div>';
  return (
    '<header class="cover">' +
    `<h1><span class="swatch" style="background:${esc(trip.color)}"></span>${esc(trip.name)}</h1>` +
    `<div class="tiny">${esc(t('print.cover.dates', { start: prettyDate(trip.startDate, { withYear: true }), end: prettyDate(trip.endDate, { withYear: true }), n: days }))} · ${esc(t('print.docKind'))}</div>` +
    companionText +
    (trip.notes ? `<p style="white-space:pre-wrap">${esc(trip.notes)}</p>` : '') +
    metrics +
    '</header>'
  );
}

export function buildPrintHtml(input: PrintInput): string {
  const { trip, sections } = input;
  const base = trip.baseCurrency;
  const parts: string[] = [];
  const section = (title: string, key: keyof PdfSections, body: string) => {
    if (!sections[key]) return;
    parts.push(`<section><h2>${esc(title)}</h2>${body}</section>`);
  };
  section(t('tab.plan'), 'itinerary', itinerarySection(input));
  section(t('tab.money'), 'expenses', expensesSection(input));
  section(t('tab.stats'), 'stats', statsSection(input));
  section(t('print.mapTitle'), 'map', mapSection(input));
  section(t('photo.title'), 'photos', photosSection(input));

  const locale = lang() === 'en' ? 'en' : 'zh-Hant';
  const hint = t('print.docTip');
  return `<!doctype html>
<html lang="${locale}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(trip.name)} — TripLog</title>
<style>${CSS}</style>
</head>
<body>
<div class="toolbar">
  <button class="primary" onclick="window.print()">🖨 ${esc(t('print.now'))}</button>
  <span class="hint">${esc(hint)}</span>
  <span style="margin-left:auto" class="hint">${esc(t('print.cover.generated', { when: new Date().toLocaleString(locale === 'en' ? 'en-US' : 'zh-TW') }))}</span>
</div>
<article class="doc">
${cover(input)}
${parts.join('\n')}
<footer class="tiny" style="margin-top:26px;border-top:1px solid #d7dce3;padding-top:8px">${esc(t('print.footer'))} · ${esc(base)}</footer>
</article>
</body>
</html>`;
}

/**
 * 把文件轉成 Blob URL：app 內的預覽（iframe）與「在新分頁開啟」共用同一個位置。
 *
 * 為什麼不再用 `window.open('', '_blank')` + `document.write`：新分頁需要彈窗權限，
 * 而被擋掉的瀏覽器（或自動化環境）會直接讓 `window.open` 回 null，整個功能就靜靜失敗。
 * 預覽放在自己的 iframe 裡不需要任何權限，要分頁時再把同一個 URL 開出去就好。
 *
 * 呼叫端在不用時要 `URL.revokeObjectURL`，否則這份 HTML（含照片）會一直留在記憶體。
 */
export function printableUrl(html: string): string {
  return URL.createObjectURL(new Blob([html], { type: 'text/html;charset=utf-8' }));
}
