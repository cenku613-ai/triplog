/**
 * 資料模型
 * 所有日期一律用本地日期字串 YYYY-MM-DD，避免時區位移問題。
 * 金額一律以「記錄當下的原始幣別」存放，換算只發生在顯示/統計層。
 */

export type ID = string;

export type ISODate = string; // YYYY-MM-DD
export type ISOTime = string; // HH:MM
export type ISODateTime = string; // full timestamp

export type CurrencyCode = string;

export interface Trip {
  id: ID;
  name: string;
  startDate: ISODate;
  endDate: ISODate;
  /** 結算用的主幣別，例如 TWD */
  baseCurrency: CurrencyCode;
  /** 總預算（以 baseCurrency 計） */
  budget?: number | null;
  /** 卡片主色，hex */
  color: string;
  notes?: string;
  /** 隨行人員名單（只有名字）；支出的付款人另存在 expense.payee */
  companions?: string[];
  archived: boolean;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

export type ItemKind = 'transport' | 'stay' | 'food' | 'sight' | 'activity' | 'other';

/** 時間軸上的一項行程 */
export interface DayItem {
  id: ID;
  tripId: ID;
  date: ISODate;
  kind: ItemKind;
  title: string;
  startTime?: ISOTime | null;
  endTime?: ISOTime | null;
  location?: string;
  /** WGS84 座標，來自搜尋或地圖點選；沒定位就是 null */
  lat?: number | null;
  lng?: number | null;
  note?: string;
  /** 手動排序，數值小的在前 */
  order: number;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

/** 一筆支出 */
export interface Expense {
  id: ID;
  tripId: ID;
  /** 可關聯到某個行程項；刪除行程項時會降級為只掛在 tripId */
  dayItemId?: ID | null;
  date: ISODate;
  amount: number;
  currency: CurrencyCode;
  /** 1 單位的 `currency` 換算成 baseCurrency 的值；同幣別時為 1 */
  rateToBase: number;
  /** 以 baseCurrency 計的金額，寫入時算好，統計時不必再算 */
  baseAmount: number;
  category: string;
  /** 誰付的 / 誰代墊 */
  payee?: string;
  note?: string;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

/**
 * 行程照片。原圖與縮圖都以 Blob 存在 IndexedDB，不經過伺服器。
 * source='commons' 時一定要留 credit（作者／授權），否則图上看不到出处。
 */
export interface Photo {
  id: ID;
  tripId: ID;
  dayItemId?: ID | null;
  /** 壓過後要顯示的圖（最長邊 ≤1600） */
  blob: Blob;
  /** 相本牆用的縮圖（最長邊 ≤400） */
  thumb: Blob;
  width: number;
  height: number;
  mime: string;
  source: 'device' | 'commons';
  /** Commons 的來源頁、作者與授權 */
  creditUrl?: string;
  artist?: string;
  license?: string;
  caption?: string;
  createdAt: ISODateTime;
}

/** 匯出用的照片：Blob 沒法直接進 JSON，轉成 base64 data URL */
export interface BackupPhoto extends Omit<Photo, 'blob' | 'thumb'> {
  data: string;
  thumbData: string;
}

export type CategoryKind = 'expense' | 'item';export interface Category {
  id: ID;
  kind: CategoryKind;
  key: string;
  label: string;
  color: string;
  order: number;
  builtin: boolean;
}

export interface MetaEntry<T = unknown> {
  key: string;
  value: T;
}

/** 汇率記憶：`${baseCurrency}>${currency}` */
export type RateMap = Record<string, number>;

export interface CurrencyDef {
  code: CurrencyCode;
  label: string;
  symbol: string;
  /** 小數位數，VND/JPy 之类常為 0 */
  decimals: number;
}

export interface BackupFile {
  format: 'triplog-backup';
  /** 1 = 純文字資料；2 起含照片（base64） */
  version: 1 | 2;
  exportedAt: ISODateTime;
  trips: Trip[];
  dayItems: DayItem[];
  expenses: Expense[];
  categories: Category[];
  photos?: BackupPhoto[];
  meta: MetaEntry[];
}
