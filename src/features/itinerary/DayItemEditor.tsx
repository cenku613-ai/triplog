import { Suspense, lazy, useMemo, useState } from 'react';
import { Modal } from '../../components/Modal';
import { Field } from '../../components/Controls';
import { PlaceSearch } from '../../components/PlaceSearch';
/** 編輯器是主頻就會載到的元件，地圖（含 Leaflet）等到真的捲到那一欄才抓 */
const MapPicker = lazy(() => import('../../components/MapPicker').then((m) => ({ default: m.MapPicker })));
import {
  MAX_TRIP_PHOTOS,
  PhotoViewer,
  PhotoWall,
  savedShots,
  type LocalShot,
  type Shot,
} from '../../components/Photos';
import { formatLatLng } from '../../lib/places';
import { useLive } from '../../db/live';
import { db, newId } from '../../db/db';
import {
  addPhotos,
  createDayItem,
  deleteDayItem,
  listCategories,
  listPhotosOfDayItem,
  nextOrder,
  removePhotos,
  updateDayItem,
} from '../../db/repo';
import type { DayItem, ItemKind, Photo, Trip } from '../../db/types';
import { useUi } from '../../app/ui';
import { useI18n } from '../../i18n';
import { categoryLabel } from '../../lib/labels';

interface Props {
  trip: Trip;
  item?: DayItem | null;
  defaultDate: string;
  onClose: () => void;
}

export function DayItemEditor({ trip, item, defaultDate, onClose }: Props) {
  const { toast, ask } = useUi();
  const { t } = useI18n();
  const categories = useLive(() => listCategories('item'), [], []);
  const [title, setTitle] = useState(item?.title ?? '');
  const [date, setDate] = useState(item?.date ?? defaultDate);
  const [kind, setKind] = useState<ItemKind>((item?.kind as ItemKind) ?? categories[0]?.key ?? 'other');
  const [startTime, setStartTime] = useState(item?.startTime ?? '');
  const [endTime, setEndTime] = useState(item?.endTime ?? '');
  const [location, setLocation] = useState(item?.location ?? '');
  const [lat, setLat] = useState<number | null>(item?.lat ?? null);
  const [lng, setLng] = useState<number | null>(item?.lng ?? null);
  const [note, setNote] = useState(item?.note ?? '');
  const [saving, setSaving] = useState(false);
  const hasCoords = lat !== null && lng !== null;

  const saved = useLive<Photo[]>(
    () => (item ? listPhotosOfDayItem(item.id) : Promise.resolve([])),
    [item?.id],
    [],
  );
  const tripPhotos = useLive<number>(
    () => db.photos.where('tripId').equals(trip.id).count(),
    [trip.id],
    0,
  );
  /** 還沒按「完成」的照片先放記憶體，按了才入庫，關掉視窗就等于放棄 */
  const [staged, setStaged] = useState<LocalShot[]>([]);
  const [dropped, setDropped] = useState<string[]>([]);
  const [viewing, setViewing] = useState<number | null>(null);

  const shots = useMemo<Shot[]>(
    () => [...savedShots(saved.filter((p) => !dropped.includes(p.id))), ...staged],
    [saved, dropped, staged],
  );
  const remaining = Math.max(0, MAX_TRIP_PHOTOS - (tripPhotos - dropped.length) - staged.length);

  async function persistPhotos(itemId: string) {
    if (dropped.length) await removePhotos(dropped);
    if (staged.length) {
      await addPhotos(
        staged.map((s) => ({
          tripId: trip.id,
          dayItemId: itemId,
          raster: s.raster,
          // 有出處連結的就是 Commons 抓來的，相本牆要顯示授權
          source: s.credit?.url ? ('commons' as const) : ('device' as const),
          creditUrl: s.credit?.url,
          artist: s.credit?.artist,
          license: s.credit?.license,
          caption: s.caption,
        })),
      );
    }
  }

  async function save(again: boolean) {
    if (!title.trim()) {
      toast(t('item.titleRequired'), { kind: 'error' });
      return;
    }
    setSaving(true);
    try {
      let itemId = item?.id ?? '';
      if (item) {
        await updateDayItem(item.id, {
          title: title.trim(),
          date,
          kind,
          startTime: startTime || null,
          endTime: endTime || null,
          location: location.trim(),
          lat,
          lng,
          note: note.trim(),
        });
      } else {
        itemId = await createDayItem({
          tripId: trip.id,
          title: title.trim(),
          date,
          kind,
          startTime: startTime || null,
          endTime: endTime || null,
          location: location.trim(),
          lat,
          lng,
          note: note.trim(),
          order: await nextOrder(trip.id, date),
        });
      }
      if (itemId && (staged.length || dropped.length)) {
        try {
          await persistPhotos(itemId);
        } catch {
          toast(t('photo.saveFailed'), { kind: 'error' });
        }
        setStaged([]);
        setDropped([]);
      }
      toast(t(item ? 'item.updated' : 'item.created'));
      if (again) {
        setTitle('');
        setLocation('');
        setNote('');
        setStartTime('');
        setEndTime('');
        setLat(null);
        setLng(null);
        setSaving(false);
        return;
      }
      onClose();
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <Modal
        title={item ? t('item.editTitle') : t('item.newTitle')}
        onClose={onClose}
        footer={
          <div className="row-between">
            {item ? (
              <button
                className="btn btn-danger btn-sm"
                onClick={async () => {
                  if (
                    await ask(t('item.deleteQ'), {
                      confirmLabel: t('item.deleteConfirm'),
                      danger: true,
                    })
                  ) {
                    await deleteDayItem(item.id);
                    toast(t('item.deleted'));
                    onClose();
                  }
                }}
              >
                {t('common.delete')}
              </button>
            ) : (
              <span />
            )}
            <div className="row">
              {!item ? (
                <button className="btn" onClick={() => void save(true)} disabled={saving}>
                  {t('item.saveAndContinue')}
                </button>
              ) : null}
              <button className="btn btn-primary" onClick={() => void save(false)} disabled={saving}>
                {t('common.done')}
              </button>
            </div>
          </div>
        }
      >
        <div className="stack">
          <Field label={t('item.title')}>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={t('item.titlePlaceholder')}
              maxLength={80}
            />
          </Field>

          <Field label={t('item.kind')}>
            <div className="cat-picker">
              {categories.map((c) => (
                <button
                  key={c.key}
                  type="button"
                  className="chip"
                  aria-pressed={c.key === kind}
                  onClick={() => setKind(c.key as ItemKind)}
                >
                  <span className="dot" style={{ color: c.color }} />
                  {categoryLabel(c)}
                </button>
              ))}
            </div>
          </Field>

          <div className="field-row">
            <Field label={t('item.date')}>
              <input type="date" value={date} min={trip.startDate} max={trip.endDate} onChange={(e) => setDate(e.target.value)} />
            </Field>
            <div className="field-row">
              <Field label={t('item.start')}>
                <input type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} />
              </Field>
              <Field label={t('item.end')}>
                <input type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} />
              </Field>
            </div>
          </div>

          <Field label={t('item.location')}>
            <input
              value={location}
              onChange={(e) => setLocation(e.target.value)}
              placeholder={t('item.locationPlaceholder')}
              maxLength={60}
            />
            {hasCoords ? (
              <div className="row" style={{ gap: 'var(--sp-2)', marginTop: 6 }}>
                <span className="tiny">{t('item.coordsSet', { coords: formatLatLng(lat as number, lng as number) })}</span>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  style={{ marginLeft: 'auto' }}
                  onClick={() => {
                    setLat(null);
                    setLng(null);
                  }}
                >
                  {t('item.coordsClear')}
                </button>
              </div>
            ) : null}
          </Field>

          <Field label={t('item.placeSearch')} hint={t('item.placeSearchHint')}>
            <PlaceSearch
              onPick={(p) => {
                setLat(p.lat);
                setLng(p.lng);
                setLocation((prev) => prev.trim() || p.name);
                setTitle((prev) => prev.trim() || p.name);
              }}
            />
          </Field>

          <Field label={t('item.map')}>
            <Suspense fallback={<div className="map-box map-pick" />}>
              <MapPicker
                lat={lat}
                lng={lng}
                onPick={(la, ln, name) => {
                  setLat(la);
                  setLng(ln);
                  if (name) {
                    setLocation((prev) => prev.trim() || name);
                    setTitle((prev) => prev.trim() || name);
                  }
                }}
              />
            </Suspense>
          </Field>

          <Field label={t('photo.title')}>
            <PhotoWall
              shots={shots}
              remaining={remaining}
              onAdd={(raster, credit, caption) =>
                setStaged((prev) => [...prev, { id: newId('shot'), kind: 'local', raster, credit, caption }])
              }
              onRemove={(shot) => {
                if (shot.kind === 'saved') setDropped((prev) => [...prev, shot.id]);
                else setStaged((prev) => prev.filter((x) => x.id !== shot.id));
              }}
              onOpen={(i) => setViewing(i)}
            />
          </Field>

          <Field label={t('item.note')}>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder={t('item.notePlaceholder')}
              maxLength={500}
            />
          </Field>
        </div>
      </Modal>
      {viewing !== null && shots[viewing] ? (
        <PhotoViewer
          shots={shots}
          index={viewing}
          onIndex={setViewing}
          onClose={() => setViewing(null)}
        />
      ) : null}
    </>
  );
}
