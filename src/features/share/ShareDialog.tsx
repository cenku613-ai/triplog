import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Modal } from '../../components/Modal';
import { Field } from '../../components/Controls';
import { useUi } from '../../app/ui';
import { useI18n } from '../../i18n';
import type { Key } from '../../i18n';
import type { Trip } from '../../db/types';
import { loadSyncConfig } from '../../lib/sync';
import { InviteSection } from './InviteSection';
import {
  activeShares,
  copyText,
  createShare,
  describeShareError,
  listShares,
  revokeShare,
  shareLink,
  type ShareRow,
} from '../../lib/share';

/** 期限選項：預設 90 天（一趟旅行撐不過一個月，留足餘裕），365 是後端的硬上限 */
const EXPIRY: { value: string; key: Key }[] = [
  { value: '30', key: 'share.expiresDays' },
  { value: '90', key: 'share.expiresDays' },
  { value: '180', key: 'share.expiresDays' },
  { value: '365', key: 'share.expiresYear' },
  { value: 'never', key: 'share.expiresNever' },
];

/** 訪客 PIN 的形狀：跟後端 normalizePin 同一條規則，差在這裡先擋掉一次往返 */
const PIN_RE = /^\d{4,8}$/;

/** 時間戳顯示成「2027/2/19, 下午2:51」：跨年時年份要看得到，不然「2/19」會誤判 */
function shortWhen(iso: string, locale: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleString(locale, { dateStyle: 'short', timeStyle: 'short' });
}

export function ShareDialog({ trip, onClose }: { trip: Trip; onClose: () => void }) {
  const { toast, ask } = useUi();
  const { t, locale } = useI18n();
  /** 分享用的就是同步那台伺服器，金鑰直接沿用同步設定，不再另存一份 */
  const cfg = useMemo(() => loadSyncConfig(), []);
  const [rows, setRows] = useState<ShareRow[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [expiry, setExpiry] = useState('90');
  const [note, setNote] = useState('');
  /** 預設能記帳：那個開關是要把連結收緊，不是要開啟新功能，舊連結的行為也一樣 */
  const [allowWrite, setAllowWrite] = useState(true);
  const [pin, setPin] = useState('');
  /** 剛產生那條：連結只在這裡完整出現一次，舊的從列表按「複製」拿 */
  const [fresh, setFresh] = useState<ShareRow | null>(null);
  /** 明文 PIN 也只在這裡出現一次：伺服器那邊只留雜湊，關掉對話框就再也拿不回來 */
  const [freshPin, setFreshPin] = useState('');

  const reload = useCallback(async () => {
    if (!cfg) return;
    try {
      setRows(await listShares(cfg, trip.id));
      setError('');
    } catch (err) {
      setError(describeShareError(err, t));
    }
  }, [cfg, trip.id, t]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const live = useMemo(() => activeShares(rows ?? []), [rows]);

  const linkOf = (row: ShareRow) => shareLink(cfg?.baseUrl ?? '', row.token);

  const copy = async (row: ShareRow) => {
    const url = linkOf(row);
    const ok = await copyText(url);
    toast(ok ? t('share.copied') : t('share.copyManual'), ok ? undefined : { kind: 'error' });
  };

  const make = async () => {
    if (!cfg) return;
    const code = pin.trim();
    // 形狀不對先在這裡講：後端那句 400 只說「訪客 PIN」，看不出該改哪裡、要改成幾個字
    if (code && !PIN_RE.test(code)) {
      setError(t('share.pinBad'));
      return;
    }
    setBusy(true);
    setError('');
    try {
      const { row, pin: issued } = await createShare(cfg, {
        tripId: trip.id,
        expiresInDays: expiry === 'never' ? 'never' : Number(expiry),
        label: note.trim() || undefined,
        canWrite: allowWrite,
        pin: code || undefined,
      });
      setFresh(row);
      setFreshPin(issued);
      setNote('');
      // 輸入框跟著清空：留著舊 PIN 會讓人以為下一條連結也是這組數字
      setPin('');
      toast(t('share.made'));
      await reload();
    } catch (err) {
      setError(describeShareError(err, t));
    } finally {
      setBusy(false);
    }
  };

  const drop = async (row: ShareRow) => {
    if (!cfg) return;
    if (!(await ask(t('share.revokeQ'), { confirmLabel: t('share.revoke'), danger: true }))) return;
    try {
      await revokeShare(cfg, row.token);
      if (fresh?.token === row.token) {
        setFresh(null);
        setFreshPin('');
      }
      toast(t('share.revoked'));
      await reload();
    } catch (err) {
      setError(describeShareError(err, t));
    }
  };

  return (
    <Modal
      title={t('share.title')}
      onClose={onClose}
      wide
      footer={
        <div className="row">
          <span className="grow" />
          <button className="btn btn-primary" onClick={onClose}>
            {t('common.done')}
          </button>
        </div>
      }
    >
      <div className="stack">
        <p className="muted" style={{ margin: 0 }}>
          {t('share.intro')}
        </p>

        {!cfg ? (
          <div className="card card-pad stack-s">
            <p style={{ margin: 0 }}>{t('share.needSync')}</p>
            <div className="row">
              <Link className="btn btn-sm" to="/settings">
                {t('share.needSyncCta')}
              </Link>
              <button className="btn btn-sm" onClick={onClose}>
                {t('common.close')}
              </button>
            </div>
          </div>
        ) : (
          <>
            {fresh ? (
              <Field label={t('share.linkLabel')} hint={t('share.notePrivacy')}>
                <div className="stack-s">
                  <input readOnly value={linkOf(fresh)} onFocus={(e) => e.currentTarget.select()} />
                  <button className="btn btn-sm btn-primary" onClick={() => void copy(fresh)}>
                    {t('share.copy')}
                  </button>
                  {/* PIN 跟連結放在一起：兩樣都要傳出去，而 PIN 只有這一次看得到 */}
                  {freshPin ? (
                    <div className="stack-s">
                      <strong style={{ fontSize: '1.1rem' }}>{t('share.pinShown', { pin: freshPin })}</strong>
                      <p className="tiny" style={{ margin: 0 }}>
                        {t('share.pinOnce')}
                      </p>
                    </div>
                  ) : null}
                </div>
              </Field>
            ) : (
              <>
                <Field label={t('share.linkLabel')} hint={t('share.syncFirst')}>
                  <div className="row wrap">
                    <select
                      value={expiry}
                      onChange={(e) => setExpiry(e.target.value)}
                      aria-label={t('share.expiresLabel')}
                    >
                      {EXPIRY.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.key === 'share.expiresDays'
                            ? t('share.expiresDays', { n: Number(o.value) })
                            : t(o.key)}
                        </option>
                      ))}
                    </select>
                    <input
                      className="grow"
                      value={note}
                      maxLength={60}
                      onChange={(e) => setNote(e.target.value)}
                      placeholder={t('share.labelPlaceholder')}
                      aria-label={t('share.labelField')}
                    />
                    <button className="btn btn-primary" onClick={() => void make()} disabled={busy}>
                      {busy ? t('share.sending') : t('share.make')}
                    </button>
                  </div>
                </Field>

                {/* 兩個收緊用的開關，預設都維持舊行為：能看也能記、不設 PIN */}
                <label className="row" style={{ gap: 8 }}>
                  <input
                    type="checkbox"
                    checked={allowWrite}
                    onChange={(e) => setAllowWrite(e.target.checked)}
                    aria-label={t('share.allowWrite')}
                  />
                  <span>
                    {t('share.allowWrite')}
                    <div className="tiny">{t('share.allowWriteHint')}</div>
                  </span>
                </label>

                <Field label={t('share.pinField')} hint={t('share.pinHint')}>
                  <input
                    value={pin}
                    onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 8))}
                    inputMode="numeric"
                    autoComplete="off"
                    maxLength={8}
                    placeholder={t('share.pinPlaceholder')}
                    aria-label={t('share.pinField')}
                  />
                </Field>
              </>
            )}

            {error ? (
              <p className="tiny" style={{ color: 'var(--danger)', margin: 0 }}>
                {error}
              </p>
            ) : null}

            <div className="stack-s" role="group" aria-label={t('share.listAria')}>
              <strong>{t('share.activeTitle')}</strong>
              {rows === null ? <span className="tiny">{t('share.making')}</span> : null}
              {rows !== null && live.length === 0 ? <span className="tiny">{t('share.noActive')}</span> : null}
              {live.map((row) => (
                <div className="row wrap" key={row.token} aria-label={t('share.rowAria', { label: row.label })}>
                  <div className="grow" style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 600 }}>
                      {row.label || trip.name}
                      {/* 唯讀與 PIN 是這條連結自己的條件：列出來才不用開連結去試 */}
                      {row.canWrite === false ? (
                        <span className="badge" style={{ marginLeft: 6 }}>
                          {t('share.readonlyTag')}
                        </span>
                      ) : null}
                      {row.hasPin ? (
                        <span className="badge" style={{ marginLeft: 6 }}>
                          {t('share.pinTag')}
                        </span>
                      ) : null}
                    </div>
                    <div className="tiny">
                      {t('share.hits', { n: row.hits })} · {t('share.writes', { n: row.writes })} ·{' '}
                      {row.lastSeenAt
                        ? t('share.lastSeen', { when: shortWhen(row.lastSeenAt, locale) })
                        : t('share.neverSeen')}
                      {/* 空字串＝還沒有人用這條記過，硬翻成「最後由  記錄」會很奇怪 */}
                      {row.lastWriter ? ` · ${t('share.lastWriter', { name: row.lastWriter })}` : ''}
                    </div>
                    <div className="tiny">
                      {row.expiresAt
                        ? t('share.expiresAt', { when: shortWhen(row.expiresAt, locale) })
                        : t('share.neverExpires')}
                    </div>
                  </div>
                  <button
                    className="btn btn-sm"
                    onClick={() => void copy(row)}
                    aria-label={t('share.copyAria', { label: row.label })}
                  >
                    {t('share.copy')}
                  </button>
                  <button
                    className="btn btn-sm btn-danger"
                    onClick={() => void drop(row)}
                    aria-label={t('share.revokeAria', { label: row.label })}
                  >
                    {t('share.revoke')}
                  </button>
                </div>
              ))}
            </div>

            <p className="tiny" style={{ margin: 0 }}>
              {t('share.noteMerge')}
            </p>
          </>
        )}

        <InviteSection trip={trip} />
      </div>
    </Modal>
  );
}
