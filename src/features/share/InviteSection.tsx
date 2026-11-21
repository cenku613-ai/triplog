import { useCallback, useEffect, useMemo, useState } from 'react';
import { useUi } from '../../app/ui';
import { useI18n } from '../../i18n';
import type { Trip } from '../../db/types';
import { loadSyncConfig } from '../../lib/sync';
import { isSessionToken } from '../../lib/tokens';
import {
  createInvite,
  describeInviteError,
  liveInvites,
  listInvites,
  looksLikeEmail,
  revokeInvite,
  type InviteRole,
  type InviteRow,
} from '../../lib/invites';

/**
 * 擁有者那一側的共筆邀請。
 *
 * 放在分享彈窗裡是有原因的：兩者解決同一個問題（「同行的人想幫我記一筆」），
 * 差在要不要給人一把看得到整本帳的鑰匙。帳號模式下邀請認的是信箱，
 * 所以這裡不產生連結、也不顯示任何要對方貼的東西——他只要登入。
 */
export function InviteSection({ trip }: { trip: Trip }) {
  const { toast, ask } = useUi();
  const { t } = useI18n();
  const cfg = useMemo(() => loadSyncConfig(), []);
  // 金鑰模式沒有身分可比對：這一塊就明說用不了，不要讓人在那裡試半天
  const available = !!cfg && isSessionToken(cfg.apiKey);
  const [rows, setRows] = useState<InviteRow[] | null>(null);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<InviteRole>('write');
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    if (!cfg || !available) return;
    try {
      setRows(await listInvites(cfg, trip.id));
    } catch (err) {
      toast(describeInviteError(err, t), { kind: 'error' });
      setRows([]);
    }
  }, [cfg, available, trip.id, toast, t]);

  useEffect(() => {
    void reload();
  }, [reload]);

  if (!cfg) {
    return (
      <div className="notice">
        {t('invite.needCfg')}
      </div>
    );
  }
  if (!available) {
    return (
      <div className="notice">
        {t('invite.off')}
      </div>
    );
  }

  const live = liveInvites(rows ?? []);

  async function add() {
    const value = email.trim().toLowerCase();
    if (!looksLikeEmail(value)) {
      toast(t('invite.badEmail'), { kind: 'error' });
      return;
    }
    setBusy(true);
    try {
      await createInvite(cfg!, { tripId: trip.id, email: value, role });
      toast(t('invite.added', { email: value }));
      setEmail('');
      await reload();
    } catch (err) {
      toast(describeInviteError(err, t), { kind: 'error' });
    } finally {
      setBusy(false);
    }
  }

  async function drop(row: InviteRow) {
    if (!(await ask(t('invite.revokeQ'), { confirmLabel: t('invite.revoke'), danger: true }))) return;
    setBusy(true);
    try {
      await revokeInvite(cfg!, row.id);
      await reload();
    } catch (err) {
      toast(describeInviteError(err, t), { kind: 'error' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card" aria-label={t('invite.title')}>
      <h3>{t('invite.title')}</h3>
      <p className="tiny">{t('invite.intro')}</p>
      <div className="row wrap" style={{ gap: 8 }}>
        <input
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder={t('invite.emailPlaceholder')}
          aria-label={t('invite.email')}
          type="email"
          autoComplete="off"
          inputMode="email"
          style={{ flex: '1 1 220px' }}
        />
        <select value={role} onChange={(e) => setRole(e.target.value as InviteRole)} aria-label={t('invite.role')}>
          <option value="write">{t('invite.roleWrite')}</option>
          <option value="read">{t('invite.roleRead')}</option>
        </select>
        <button className="btn btn-primary btn-sm" onClick={() => void add()} disabled={busy}>
          {busy ? t('invite.busy') : t('invite.add')}
        </button>
      </div>
      <p className="tiny">{t('invite.emailHint')}</p>

      {rows === null ? null : live.length === 0 ? (
        <p className="tiny">{t('invite.empty')}</p>
      ) : (
        <ul className="list" aria-label={t('invite.title')}>
          {live.map((row) => (
            <li key={row.id} className="row" style={{ justifyContent: 'space-between', gap: 8 }}>
              <span>
                {t('invite.row', { email: row.email, role: row.role === 'read' ? t('invite.roleRead') : t('invite.roleWrite') })}
              </span>
              <button className="btn btn-sm" onClick={() => void drop(row)} disabled={busy}>
                {t('invite.revoke')}
              </button>
            </li>
          ))}
        </ul>
      )}
      <p className="tiny">{t('invite.tell')}</p>
    </section>
  );
}
