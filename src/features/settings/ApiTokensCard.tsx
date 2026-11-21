/**
 * 「設定 → API token」：主金鑰之外，能單獨撤銷的憑證。
 *
 * 為什麼要這張卡：TRIPLOG_API_KEY 是整座資料庫的密碼，交給 AI agent 或再添一台裝置時
 * 一旦外流，補救只能換鑰匙再一台一台重貼。這裡簽發的 token 自帶層級（唯讀／可寫）與
 * 期限，資料庫只存雜湊，而且清單上看得得到它何時被用過、動過幾筆——所以能「只收掉那把」。
 *
 * 呼叫 /api/tokens 一定要用主金鑰：拿簽發出去的 token 叫它再發一把，等於任何一把外流的
 * agent 憑證都能自己擴權，那就白設計了。所以這張卡在設定裡同步金鑰填的是只讀鑰時會 403，
 * 錯誤訊息（tokens.errAuth）講的就是這件事。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useUi } from '../../app/ui';
import { useI18n } from '../../i18n';
import type { Key } from '../../i18n';
import { Field } from '../../components/Controls';
import { copyText } from '../../lib/share';
import { loadSyncConfig } from '../../lib/sync';
import {
  activeTokens,
  createApiToken,
  describeTokenError,
  listApiTokens,
  revokeApiToken,
  tokenState,
  type ApiTokenRow,
  type TokenScope,
  type TokenState,
} from '../../lib/tokens';

/** 30/90/365 對應後端的期限上限（365 硬擋），不設限期留給「自己那台裝置」這種長期用途 */
const EXPIRY: { value: string; key: Key }[] = [
  { value: '30', key: 'tokens.expires30' },
  { value: '90', key: 'tokens.expires90' },
  { value: '365', key: 'tokens.expires365' },
  { value: 'never', key: 'tokens.expiresNever' },
];

const STATE_KEY: Record<TokenState, Key> = {
  active: 'tokens.stateActive',
  expired: 'tokens.stateExpired',
  revoked: 'tokens.stateRevoked',
};

const SCOPE_KEY: Record<TokenScope, Key> = {
  read: 'tokens.scopeRead',
  write: 'tokens.scopeWrite',
};

/** 時間戳跨年時年份要看得到，否則「2/19」會被讀成今年 */
function when(iso: string | null, locale: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(locale, { dateStyle: 'short', timeStyle: 'short' });
}

type Fresh = { secret: string; row: ApiTokenRow };

export function ApiTokensCard() {
  const { toast, ask } = useUi();
  const { t, locale } = useI18n();
  /** 發 token 用的就是同步那台伺服器與那把主金鑰，不另存一份設定 */
  const cfg = useMemo(() => loadSyncConfig(), []);
  const [rows, setRows] = useState<ApiTokenRow[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [label, setLabel] = useState('');
  const [scope, setScope] = useState<TokenScope>('read');
  const [expiry, setExpiry] = useState('90');
  /** 完整值只在這一次看得到（資料庫只有雜湊），所以用一塊一次性的區域顯示，收起來就再也拿不回來 */
  const [fresh, setFresh] = useState<Fresh | null>(null);

  const reload = useCallback(async () => {
    if (!cfg) return;
    try {
      setRows(await listApiTokens(cfg));
      setError('');
    } catch (err) {
      setRows([]);
      setError(describeTokenError(err, t));
    }
  }, [cfg, t]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // 生效中的排前面，其餘依發出時間從新到舊（撤銷記錄留著，才能看出什麼時候收手過）
  const ordered = useMemo(() => {
    const all = rows ?? [];
    const live = activeTokens(all);
    const rest = all
      .filter((r) => !live.includes(r))
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    return [...live.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))), ...rest];
  }, [rows]);

  const fail = (err: unknown) => setError(describeTokenError(err, t));

  const make = async () => {
    if (!cfg || busy) return;
    setBusy(true);
    setError('');
    try {
      const minted = await createApiToken(cfg, {
        label: label.trim(),
        scope,
        expiresInDays: expiry === 'never' ? 'never' : Number(expiry),
      });
      setFresh(minted);
      setLabel('');
      await reload();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  const copy = async (text: string) => {
    const ok = await copyText(text);
    toast(ok ? t('tokens.copied') : t('tokens.copyFail'), ok ? undefined : { kind: 'error' });
  };

  const drop = async (row: ApiTokenRow) => {
    if (!cfg || busy) return;
    const name = row.label || row.hint;
    if (!(await ask(t('tokens.revokeQ'), { confirmLabel: t('tokens.revoke'), danger: true }))) return;
    setBusy(true);
    setError('');
    try {
      await revokeApiToken(cfg, row.id);
      if (fresh?.row.id === row.id) setFresh(null);
      toast(t('tokens.revoked', { label: name }));
      await reload();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card card-pad stack">
      <h3>{t('tokens.title')}</h3>
      <p className="muted" style={{ fontSize: 14, margin: 0 }}>
        {t('tokens.body')}
      </p>

      {!cfg ? (
        <div className="notice">{t('tokens.needSync')}</div>
      ) : (
        <>
          <div className="stack-s">
            <Field label={t('tokens.label')} hint={t('tokens.labelHint')}>
              <input
                value={label}
                maxLength={60}
                onChange={(e) => setLabel(e.target.value)}
                placeholder={t('tokens.labelPlaceholder')}
                autoComplete="off"
              />
            </Field>

            <Field
              label={t('tokens.scope')}
              hint={scope === 'write' ? t('tokens.scopeWriteHint') : t('tokens.scopeReadHint')}
            >
              <div className="row wrap" role="group" aria-label={t('tokens.scope')}>
                {(['read', 'write'] as TokenScope[]).map((s) => (
                  <label className="row" key={s} style={{ gap: 8 }}>
                    <input
                      type="radio"
                      name="token-scope"
                      checked={scope === s}
                      onChange={() => setScope(s)}
                    />
                    <span style={{ fontSize: 14 }}>{t(SCOPE_KEY[s])}</span>
                  </label>
                ))}
              </div>
            </Field>

            <Field label={t('tokens.expires')}>
              <div className="row wrap">
                <select
                  className="grow"
                  value={expiry}
                  onChange={(e) => setExpiry(e.target.value)}
                  aria-label={t('tokens.expires')}
                >
                  {EXPIRY.map((o) => (
                    <option key={o.value} value={o.value}>
                      {t(o.key)}
                    </option>
                  ))}
                </select>
                <button className="btn btn-primary" onClick={() => void make()} disabled={busy}>
                  {busy ? t('tokens.creating') : t('tokens.create')}
                </button>
              </div>
            </Field>
          </div>

          {fresh ? (
            <div className="stack-s" style={{ padding: 12, border: '1px solid var(--line)', borderRadius: 12 }}>
              <strong>{t('tokens.created')}</strong>
              <input readOnly value={fresh.secret} onFocus={(e) => e.currentTarget.select()} spellCheck={false} />
              <p className="tiny" style={{ margin: 0, color: 'var(--danger)' }}>
                {t('tokens.once')}
              </p>
              <div className="row wrap">
                <button className="btn btn-sm btn-primary" onClick={() => void copy(fresh.secret)}>
                  {t('tokens.copy')}
                </button>
                <button className="btn btn-sm" onClick={() => setFresh(null)}>
                  {t('tokens.dismiss')}
                </button>
              </div>
              <p className="tiny" style={{ margin: 0 }}>
                {t('tokens.mcpHint', { url: cfg.baseUrl })}
              </p>
            </div>
          ) : null}

          {error ? (
            <p className="tiny" style={{ color: 'var(--danger)', margin: 0 }}>
              {error}
            </p>
          ) : null}

          <div className="stack-s" role="group" aria-label={t('tokens.list')}>
            <div className="row">
              <strong className="grow">{t('tokens.list')}</strong>
              <button className="btn btn-sm btn-ghost" onClick={() => void reload()} disabled={busy}>
                {t('tokens.refresh')}
              </button>
            </div>
            {rows === null ? <span className="tiny">{t('tokens.loading')}</span> : null}
            {rows !== null && ordered.length === 0 ? <span className="tiny">{t('tokens.empty')}</span> : null}
            {ordered.map((row) => {
              const state = tokenState(row);
              return (
                <div
                  className="row wrap"
                  key={row.id}
                  style={{ gap: 8 }}
                  aria-label={t('tokens.rowAria', { label: row.label || row.hint })}
                >
                  <div className="grow" style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 600 }}>
                      {row.label || row.hint}
                      {row.label ? <span className="tiny"> · {row.hint}</span> : null}
                    </div>
                    <div className="tiny">
                      {t('tokens.usage', { hits: row.hits, writes: row.writes })} ·{' '}
                      {row.lastSeenAt
                        ? t('tokens.lastSeen', { when: when(row.lastSeenAt, locale) })
                        : t('tokens.neverUsed')}
                    </div>
                    <div className="tiny">
                      {row.expiresAt
                        ? t('tokens.expiresAt', { when: when(row.expiresAt, locale) })
                        : t('tokens.noExpiry')}
                    </div>
                  </div>
                  <div className="row" style={{ gap: 6 }}>
                    <span className="badge" aria-label={t('tokens.scopeAria', { scope: t(SCOPE_KEY[row.scope]) })}>
                      {t(STATE_KEY[state])}
                    </span>
                    <span className="badge">{t(SCOPE_KEY[row.scope])}</span>
                  </div>
                  {state === 'active' ? (
                    <button
                      className="btn btn-sm btn-danger"
                      onClick={() => void drop(row)}
                      disabled={busy}
                      aria-label={t('tokens.revokeAria', { label: row.label || row.hint })}
                    >
                      {t('tokens.revoke')}
                    </button>
                  ) : null}
                </div>
              );
            })}
          </div>
        </>
      )}
    </section>
  );
}
