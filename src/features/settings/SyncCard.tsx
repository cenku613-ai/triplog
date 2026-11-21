/**
 * 「跨裝置同步」設定卡。
 *
 * 這裡只做一件事：把伺服器位址／金鑰存進 localStorage，然後提供四個動作
 * （測試連線、雙向往返、只拉下來、整包推上去）與一趟一趟抓回來的清單。
 * 真正的合併規則在 src/lib/merge-core.js，跟後端共用同一份，所以這裡不需要
 * 也完全不該判斷「誰蓋掉誰」。
 *
 * 連線方式有兩條：貼金鑰（原有）與「用配對碼連線」。後者是為了讓新裝置不必經手長金鑰——
 * 在擁有者的 app 裡產生一組 8 個字的一次性配對碼，這裡打完那 8 個字就換到一把屬於這台
 * 裝置的憑證（`tlk_…`），本機存的從此是可單獨撤銷的憑證，不是整座資料庫的密碼。
 */
import { useEffect, useState } from 'react';
import { useUi } from '../../app/ui';
import { useI18n } from '../../i18n';
import { Field } from '../../components/Controls';
import { describeTokenError, pairCodeProgress, pairWithCode } from '../../lib/tokens';
import {
  describeSyncError,
  lastSyncAt,
  listRemoteTrips,
  loadSyncConfig,
  pullFromServer,
  pullTrip,
  pushToServer,
  saveSyncConfig,
  syncNow,
  testConnection,
  type SyncConfig,
  type SyncReport,
} from '../../lib/sync';

type Action = 'test' | 'sync' | 'pull' | 'push' | 'one' | 'pair' | null;
type Mode = 'key' | 'code';

/** 後端回來的位元組換成 KB，列表才不會一坨數字 */
function kb(bytes: number): string {
  return (bytes / 1024).toFixed(bytes > 512 * 1024 ? 0 : 1);
}

export function SyncCard() {
  const { toast, ask } = useUi();
  const { t, locale } = useI18n();
  const saved = loadSyncConfig();
  const [mode, setMode] = useState<Mode>(saved ? 'key' : 'code');
  const [baseUrl, setBaseUrl] = useState(saved?.baseUrl ?? '');
  const [apiKey, setApiKey] = useState(saved?.apiKey ?? '');
  const [auto, setAuto] = useState(saved?.auto ?? false);
  const [code, setCode] = useState('');
  const [device, setDevice] = useState('');
  const [busy, setBusy] = useState<Action>(null);
  const [report, setReport] = useState<SyncReport | null>(null);
  const [remote, setRemote] = useState<Awaited<ReturnType<typeof listRemoteTrips>>>([]);
  const [at, setAt] = useState<string | null>(() => lastSyncAt());

  const cfg: SyncConfig | null = baseUrl.trim() && apiKey.trim()
    ? { baseUrl: baseUrl.trim(), apiKey: apiKey.trim(), auto }
    : null;
  const codeHint = (() => {
    const { left, bad, ready } = pairCodeProgress(code);
    if (ready || !code.trim()) return '';
    return bad ? t('keys.codeBadChars') : t('keys.codeIncomplete', { n: left });
  })();

  // 換裝置時第一次進這頁，清單是空的；有設定就自己拉一次
  useEffect(() => {
    if (!cfg) return;
    let cancelled = false;
    listRemoteTrips(cfg)
      .then((rows) => !cancelled && setRemote(rows))
      .catch(() => !cancelled && setRemote([]));
    return () => {
      cancelled = true;
    };
    // 只在位址/金鑰改變時重抓，不然每次按按鈕都會多打一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseUrl, apiKey]);

  async function run(action: Exclude<Action, null>, fn: () => Promise<void>) {
    setBusy(action);
    try {
      await fn();
    } catch (err) {
      toast(describeSyncError(err), { kind: 'error' });
    } finally {
      setBusy(null);
    }
  }

  /**
   * 配對：只需要位址與那 8 個字，這條路不帶任何金鑰（也不需要）。換到的憑證直接成為
   * 這台裝置的同步金鑰，所以配對完就把表單上的金鑰欄位換掉——主金鑰不會進到這台裝置。
   */
  async function pair() {
    const url = baseUrl.trim();
    if (!url) {
      toast(t('keys.errNoServer'), { kind: 'error' });
      return;
    }
    if (!pairCodeProgress(code).ready) {
      toast(t('keys.errShape'), { kind: 'error' });
      return;
    }
    setBusy('pair');
    try {
      const res = await pairWithCode(url, code, device.trim());
      saveSyncConfig({ baseUrl: url, apiKey: res.secret, auto });
      setApiKey(res.secret);
      setCode('');
      setMode('key');
      toast(t('keys.codeOk'));
      const r = await pullFromServer({ baseUrl: url, apiKey: res.secret, auto });
      showReport(r, t('sync.pull'));
      setRemote(await listRemoteTrips({ baseUrl: url, apiKey: res.secret, auto }).catch(() => []));
    } catch (err) {
      toast(describeTokenError(err, t), { kind: 'error' });
    } finally {
      setBusy(null);
    }
  }

  function showReport(r: SyncReport, label: string) {
    setReport(r);
    setAt(r.at);
    toast(
      `${label} · ${t('sync.report', {
        pTrips: r.pulled.trips,
        pItems: r.pulled.dayItems,
        pExp: r.pulled.expenses,
        nTrips: r.pushed.trips,
        photos: r.photosDownloaded,
      })}`,
    );
  }

  return (
    <section className="card card-pad stack">
      <h3>{t('sync.title')}</h3>
      <p className="muted" style={{ fontSize: 14 }}>
        {t('sync.body')}
      </p>

      <div className="tabs" role="group" aria-label={t('keys.title')}>
        {(['code', 'key'] as Mode[]).map((m) => (
          <button key={m} type="button" aria-selected={mode === m} onClick={() => setMode(m)}>
            {m === 'code' ? t('keys.connectWithCode') : t('keys.connectWithKey')}
          </button>
        ))}
      </div>

      <Field label={t(mode === 'code' ? 'keys.codeServer' : 'sync.baseUrl')}>
        <input
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          placeholder={t('sync.baseUrlPlaceholder')}
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
        />
      </Field>

      {mode === 'code' ? (
        <>
          <Field label={t('keys.pairTitle')} hint={t('keys.pairHowto')}>
            <input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder={t('keys.codePlaceholder')}
              maxLength={10}
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              style={{ textAlign: 'center', letterSpacing: '0.1em', textTransform: 'uppercase' }}
            />
          </Field>
          {codeHint ? (
            <p className="tiny" style={{ margin: 0, color: 'var(--danger)' }}>
              {codeHint}
            </p>
          ) : null}
          <Field label={t('keys.codeDevice')}>
            <input
              value={device}
              onChange={(e) => setDevice(e.target.value)}
              maxLength={40}
              autoComplete="off"
              placeholder={t('tokens.labelPlaceholder')}
            />
          </Field>
          <div className="row wrap">
            <button
              className="btn btn-primary btn-sm"
              disabled={busy !== null || !pairCodeProgress(code).ready || !baseUrl.trim()}
              onClick={() => void pair()}
            >
              {busy === 'pair' ? t('keys.codeWorking') : t('keys.codeSubmit')}
            </button>
          </div>
        </>
      ) : (
        <Field label={t('sync.key')} hint={t('sync.keyHint')}>
          <input
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={t('sync.keyPlaceholder')}
            type="password"
            autoComplete="off"
            spellCheck={false}
          />
        </Field>
      )}
      <label className="row" style={{ gap: 8 }}>
        <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
        <span>
          {t('sync.auto')}
          <div className="tiny">{t('sync.autoHint')}</div>
        </span>
      </label>

      <div className="notice" style={{ fontSize: 13 }}>
        {t('sync.photoWarn')}
      </div>

      <div className="row wrap">
        <button
          className="btn btn-primary btn-sm"
          disabled={!cfg || busy !== null}
          onClick={() =>
            run('sync', async () => {
              const r = await syncNow(cfg!);
              showReport(r, t('sync.now'));
              setRemote(await listRemoteTrips(cfg!).catch(() => remote));
            })
          }
        >
          {busy === 'sync' ? t('sync.testing') : t('sync.now')}
        </button>
        <button
          className="btn btn-sm"
          disabled={!cfg || busy !== null}
          onClick={() =>
            run('pull', async () => {
              const r = await pullFromServer(cfg!);
              showReport(r, t('sync.pull'));
            })
          }
        >
          {busy === 'pull' ? t('sync.testing') : t('sync.pull')}
        </button>
        <button
          className="btn btn-sm"
          disabled={!cfg || busy !== null}
          onClick={() =>
            run('push', async () => {
              const r = await pushToServer(cfg!);
              showReport(r, t('sync.push'));
              setRemote(await listRemoteTrips(cfg!).catch(() => remote));
            })
          }
        >
          {busy === 'push' ? t('sync.testing') : t('sync.push')}
        </button>
        <button
          className="btn btn-sm"
          disabled={!cfg || busy !== null}
          onClick={() =>
            run('test', async () => {
              const r = await testConnection(cfg!);
              toast(r.trips ? t('sync.testOk', { bytes: kb(r.bytes), trips: r.trips }) : t('sync.testOkEmpty'));
            })
          }
        >
          {busy === 'test' ? t('sync.testing') : t('sync.test')}
        </button>
      </div>

      <div className="row wrap">
        <button
          className="btn btn-sm"
          onClick={() => {
            if (!cfg) {
              toast(t('sync.needSetup'), { kind: 'error' });
              return;
            }
            saveSyncConfig(cfg);
            toast(t('sync.saved'));
          }}
        >
          {t('sync.save')}
        </button>
        {saved ? (
          <button
            className="btn btn-sm"
            onClick={async () => {
              if (!(await ask(t('sync.clear'), { confirmLabel: t('sync.clear'), danger: true }))) return;
              saveSyncConfig(null);
              setRemote([]);
              setReport(null);
              toast(t('sync.cleared'));
            }}
          >
            {t('sync.clear')}
          </button>
        ) : null}
        <span className="tiny">
          {at
            ? t('sync.lastAt', {
                when: new Intl.DateTimeFormat(locale, {
                  month: 'numeric',
                  day: 'numeric',
                  hour: '2-digit',
                  minute: '2-digit',
                }).format(new Date(at)),
              })
            : t('sync.never')}
        </span>
      </div>

      {report ? (
        <p className="tiny">
          {t('sync.report', {
            pTrips: report.pulled.trips,
            pItems: report.pulled.dayItems,
            pExp: report.pulled.expenses,
            nTrips: report.pushed.trips,
            photos: report.photosDownloaded,
          })}
          {' · '}
          {kb(report.remoteBytes)} KB
        </p>
      ) : null}

      {remote.length ? (
        <div className="stack-s">
          <h4 style={{ margin: 0 }}>{t('sync.remoteTrips')}</h4>
          {remote.map((r) => (
            <div className="row" key={r.id}>
              <span className="grow" style={{ fontSize: 14 }}>
                {r.name}
                <span className="tiny"> · {r.startDate}–{r.endDate} · {r.items}/{r.expenses}</span>
              </span>
              <button
                className="btn btn-sm"
                disabled={busy !== null}
                onClick={() =>
                  run('one', async () => {
                    const res = await pullTrip(cfg!, r.id);
                    toast(t('sync.pulledTrip', res));
                  })
                }
              >
                {busy === 'one' ? t('sync.testing') : t('sync.pullThis')}
              </button>
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}
