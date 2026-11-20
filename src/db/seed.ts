import { db, newId, now } from './db';
import { listCategories } from './repo';
import type { DayItem, Expense, Trip } from './types';
import { addDays, today } from '../lib/dates';
import { currencyDef, roundTo } from './currency';
import { t } from '../i18n';

/** 產生一組可直接看的示範資料，讓第一次開站就能體驗 */
export async function seedDemo(): Promise<string> {
  const cats = await listCategories('expense');
  const pick = (key: string) => cats.find((c) => c.key === key)?.id ?? cats[0].id;
  const start = addDays(today(), -1);
  const ts = now();

  const trip: Trip = {
    id: newId('trip'),
    name: t('seed.tripName'),
    startDate: start,
    endDate: addDays(start, 3),
    baseCurrency: 'TWD',
    budget: 30000,
    color: '#0f766e',
    notes: t('seed.tripNotes'),
    companions: [t('seed.companion1'), t('seed.companion2')],
    archived: false,
    createdAt: ts,
    updatedAt: ts,
  };

  type RawItem = {
    date: string;
    kind: DayItem['kind'];
    title: string;
    startTime?: string;
    endTime?: string;
    location?: string;
    order: number;
    /** 示範座標（真實地點），讓「地圖」分頁第一次點開就有東西看 */
    lat?: number;
    lng?: number;
  };

  const rawItems: RawItem[] = [
    { date: start, kind: 'transport', title: t('seed.item1'), startTime: '09:40', endTime: '11:20', location: t('seed.loc1'), order: 10, lat: 34.9857, lng: 135.7588 },
    { date: start, kind: 'stay', title: t('seed.item2'), startTime: '15:00', location: t('seed.loc2'), order: 20, lat: 35.0044, lng: 135.7664 },
    { date: start, kind: 'food', title: t('seed.item3'), startTime: '19:00', location: t('seed.loc3'), order: 30, lat: 35.0017, lng: 135.7673 },
    { date: addDays(start, 1), kind: 'sight', title: t('seed.item4'), startTime: '08:30', order: 10, lat: 34.9671, lng: 135.7727 },
    { date: addDays(start, 1), kind: 'activity', title: t('seed.item5'), startTime: '13:30', endTime: '17:00', order: 20, lat: 35.0146, lng: 135.6733 },
    { date: addDays(start, 2), kind: 'sight', title: t('seed.item6'), startTime: '17:30', order: 10, lat: 34.9949, lng: 135.785 },
    { date: addDays(start, 2), kind: 'transport', title: t('seed.item7'), startTime: '11:00', order: 20, lat: 35.0057, lng: 135.7647 },
    { date: addDays(start, 3), kind: 'transport', title: t('seed.item8'), startTime: '10:00', order: 10, lat: 34.9857, lng: 135.7588 },
  ];

  const items: DayItem[] = rawItems.map((i) => ({
    ...i,
    id: newId('item'),
    tripId: trip.id,
    note: '',
    location: i.location ?? '',
    endTime: i.endTime ?? null,
    startTime: i.startTime ?? null,
    lat: i.lat ?? null,
    lng: i.lng ?? null,
    createdAt: ts,
    updatedAt: ts,
  }));

  const JPY = 0.235;
  const payers = trip.companions ?? [];
  const rawExp: Array<[itemIdx: number, amount: number, currency: string, catKey: string, dayOffset: number, note: string]> = [
    [0, 3600, 'JPY', 'transport', 0, t('seed.exp1')],
    [1, 42000, 'JPY', 'stay', 0, t('seed.exp2')],
    [2, 2900, 'JPY', 'food', 0, t('seed.exp3')],
    [4, 2100, 'JPY', 'fun', 1, t('seed.exp4')],
    [5, 800, 'JPY', 'ticket', 2, t('seed.exp5')],
    [6, 5400, 'JPY', 'shopping', 2, t('seed.exp6')],
    [-1, 1450, 'JPY', 'food', 2, t('seed.exp7')],
    [7, 2970, 'JPY', 'transport', 3, t('seed.exp8')],
  ];

  const expenses: Expense[] = rawExp
    .filter(([, amount]) => amount > 0)
    .map(([itemIdx, amount, currency, catKey, dayOffset, note], i) => {
      const def = currencyDef(currency);
      const rate = currency === trip.baseCurrency ? 1 : JPY;
      return {
        id: newId('exp'),
        tripId: trip.id,
        dayItemId: itemIdx >= 0 ? items[itemIdx].id : null,
        date: addDays(start, dayOffset),
        amount: roundTo(amount, def.decimals),
        currency,
        rateToBase: rate,
        baseAmount: roundTo(amount * rate, 2),
        category: pick(catKey),
        // 故意讓兩個人交替代墊，統計頁一眼看得出差別
        payee: i % 3 === 2 ? payers[1] : payers[0],
        note,
        createdAt: ts,
        updatedAt: ts,
      };
    });

  await db.transaction('rw', [db.trips, db.dayItems, db.expenses], async () => {
    await db.trips.add(trip);
    await db.dayItems.bulkAdd(items);
    await db.expenses.bulkAdd(expenses);
  });

  localStorage.setItem('triplog:lastTrip', trip.id);
  return trip.id;
}
