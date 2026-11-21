import { useRef, useState } from 'react';
import { useLive } from '../../db/live';
import { db } from '../../db/db';
import {
  addCategory,
  clearAll,
  exportBackup,
  importBackup,
  listCategories,
  parseBackup,
  removeCategory,
  renameCategory,
} from '../../db/repo';
import type { Category } from '../../db/types';
import { seedDemo } from '../../db/seed';
import { useUi } from '../../app/ui';
import { useInstallPrompt, usePwaUpdate } from '../../app/pwa';
import { today } from '../../lib/dates';
import { useI18n, type Lang } from '../../i18n';
import { categoryLabel } from '../../lib/labels';
import { Field } from '../../components/Controls';
import { SyncCard } from './SyncCard';

const SWATCH = ['#0f766e', '#2f7ed8', '#7c5cd6', '#d64576', '#e07a3f', '#c9962b', '#6b7280'];
/** 語言選單一律用母語顯示，所以名稱不進字典 */
const LANGS: { code: Lang; label: string }[] = [
  { code: 'zh-Hant', label: '繁體中文' },
  { code: 'en', label: 'English' },
];

export function SettingsPage() {
  const { toast, ask, theme, setTheme } = useUi();
  const { t, lang, setLang } = useI18n();
  const categories = useLive<Category[]>(() => listCategories('expense'), [], []);
  const counts = useLive(
    async () => ({
      trips: await db.trips.count(),
      items: await db.dayItems.count(),
      expenses: await db.expenses.count(),
      photos: await db.photos.count(),
    }),
    [],
    { trips: 0, items: 0, expenses: 0, photos: 0 },
  );
  const [newCat, setNewCat] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [importMode, setImportMode] = useState<'merge' | 'replace'>('merge');
  const fileRef = useRef<HTMLInputElement>(null);
  const { canInstall, promptInstall, installed, isIos } = useInstallPrompt();
  const { needRefresh, reload } = usePwaUpdate();
  const [usage, setUsage] = useState<string>('');

  async function download() {
    const data = await exportBackup();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `triplog-backup-${today()}.json`;
    a.click();
    URL.revokeObjectURL(url);
    toast(t('settings.exported', { n: data.trips.length }));
  }

  async function onFile(file: File) {
    try {
      const data = parseBackup(await file.text());
      const res = await importBackup(data, importMode);
      toast(
        t('settings.imported', {
          trips: res.trips,
          items: res.items,
          expenses: res.expenses,
          photos: res.photos,
        }),
      );
    } catch (err) {
      console.error(err);
      toast(err instanceof Error ? err.message : t('settings.importFailed'), { kind: 'error' });
    } finally {
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  async function checkStorage() {
    if (!navigator.storage?.estimate) {
      toast(t('settings.storageUnknown'), { kind: 'error' });
      return;
    }
    const est = await navigator.storage.estimate();
    const used = (est.usage ?? 0) / 1024 / 1024;
    const quota = (est.quota ?? 0) / 1024 / 1024;
    const text = t('settings.storageUsed', { used: used.toFixed(1), quota: quota.toFixed(0) });
    setUsage(text);
    toast(text);
  }

  return (
    <div className="settings">
      <div className="settings-head">
        <h1>{t('settings.title')}</h1>
        <p className="muted" style={{ fontSize: 14 }}>
          {t('settings.counts', counts)}
        </p>
      </div>

      <section className="card card-pad stack">
        <h3>{t('settings.appearance')}</h3>
        <Field label={t('settings.theme')}>
          <div className="tabs" role="group" aria-label={t('settings.theme')}>
            {(['system', 'light', 'dark'] as const).map((m) => (
              <button key={m} aria-selected={theme === m} onClick={() => setTheme(m)} type="button">
                {m === 'system'
                  ? t('settings.themeSystem')
                  : m === 'light'
                    ? t('settings.themeLight')
                    : t('settings.themeDark')}
              </button>
            ))}
          </div>
        </Field>
        <Field label={t('settings.language')} hint={t('settings.languageHint')}>
          <div className="tabs" role="group" aria-label={t('settings.language')}>
            {LANGS.map((l) => (
              <button key={l.code} type="button" aria-selected={lang === l.code} onClick={() => setLang(l.code)}>
                {l.label}
              </button>
            ))}
          </div>
        </Field>
      </section>

      <section className="card card-pad stack">
        <h3>{t('settings.installOffline')}</h3>
        {installed ? (
          <div className="notice">{t('settings.installed')}</div>
        ) : (
          <>
            <p className="muted" style={{ fontSize: 14 }}>
              {t('settings.installBody')}
            </p>
            {canInstall ? (
              <button
                className="btn btn-primary"
                onClick={async () => {
                  const r = await promptInstall();
                  toast(
                    r === 'accepted'
                      ? t('settings.installAccepted')
                      : r === 'dismissed'
                        ? t('settings.installDismissed')
                        : t('settings.installUnavailable'),
                    { kind: r === 'accepted' ? 'info' : 'error' },
                  );
                }}
              >
                {t('settings.installBtn')}
              </button>
            ) : null}
            {isIos && !installed ? <div className="notice">{t('settings.iosHint')}</div> : null}
          </>
        )}
        <div className="row wrap">
          <button className="btn btn-sm" onClick={() => void checkStorage()}>
            {t('settings.checkStorage')}
          </button>
          {usage ? <span className="tiny">{usage}</span> : null}
          {needRefresh ? (
            <button className="btn btn-sm btn-primary" onClick={reload}>
              {t('settings.updateBtn')}
            </button>
          ) : null}
        </div>
      </section>

      <section className="card card-pad stack">
        <h3>{t('settings.categories')}</h3>
        <div className="stack-s">
          {categories.map((c) => {
            const label = categoryLabel(c);
            return (
              <div className="row" key={c.id}>
                <span
                  aria-hidden="true"
                  style={{ width: 14, height: 14, borderRadius: 4, background: c.color, flex: '0 0 14px' }}
                />
                {editing === c.id ? (
                  <>
                    <input
                      defaultValue={label}
                      autoFocus
                      maxLength={24}
                      onBlur={(e) => {
                        const v = e.target.value.trim();
                        if (v && v !== label) void renameCategory(c.id, { label: v });
                        setEditing(null);
                      }}
                      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
                    />
                    <div className="swatches">
                      {SWATCH.map((s) => (
                        <button
                          key={s}
                          className="swatch"
                          style={{ background: s, width: 22, height: 22 }}
                          aria-label={t('settings.colorAria', { color: s })}
                          aria-pressed={s === c.color}
                          onClick={async () => {
                            await renameCategory(c.id, { color: s });
                            setEditing(null);
                          }}
                        />
                      ))}
                    </div>
                  </>
                ) : (
                  <>
                    <span className="grow">{label}</span>
                    {c.builtin ? <span className="badge">{t('settings.builtin')}</span> : null}
                    <button
                      className="icon-btn"
                      aria-label={t('settings.editCatAria', { label })}
                      onClick={() => setEditing(c.id)}
                    >
                      ✎
                    </button>
                    {!c.builtin ? (
                      <button
                        className="icon-btn"
                        aria-label={t('settings.delCatAria', { label })}
                        onClick={async () => {
                          if (
                            await ask(t('settings.delCatQ', { label }), { confirmLabel: t('common.delete') })
                          ) {
                            await removeCategory(c.id);
                            toast(t('settings.catDeleted'));
                          }
                        }}
                      >
                        ✕
                      </button>
                    ) : null}
                  </>
                )}
              </div>
            );
          })}
        </div>
        <div className="row">
          <input
            className="grow"
            value={newCat}
            onChange={(e) => setNewCat(e.target.value)}
            placeholder={t('settings.newCatPlaceholder')}
            maxLength={24}
            aria-label={t('settings.newCatAria')}
          />
          <button
            className="btn btn-primary btn-sm"
            onClick={async () => {
              if (!newCat.trim()) return;
              await addCategory('expense', newCat.trim(), SWATCH[(Math.random() * SWATCH.length) | 0]);
              setNewCat('');
              toast(t('settings.catAdded'));
            }}
          >
            {t('common.add')}
          </button>
        </div>
      </section>

      <section className="card card-pad stack">
        <h3>{t('settings.backup')}</h3>
        <p className="muted" style={{ fontSize: 14 }}>
          {t('settings.backupBody')}
        </p>
        <div className="row wrap">
          <button className="btn btn-primary" onClick={() => void download()}>
            {t('settings.export')}
          </button>
          <div className="row wrap">
            <select
              value={importMode}
              onChange={(e) => setImportMode(e.target.value as 'merge' | 'replace')}
              aria-label={t('settings.importModeAria')}
              style={{ width: 'auto' }}
            >
              <option value="merge">{t('settings.importMerge')}</option>
              <option value="replace">{t('settings.importReplace')}</option>
            </select>
            <button className="btn" onClick={() => fileRef.current?.click()}>
              {t('settings.pickBackup')}
            </button>
            <input
              ref={fileRef}
              type="file"
              accept="application/json,.json"
              className="hide"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void onFile(f);
              }}
            />
          </div>
        </div>
      </section>

      <SyncCard />

      <section className="card card-pad stack">
        <h3>{t('settings.demo')}</h3>
        <p className="muted" style={{ fontSize: 14 }}>
          {t('settings.demoBody')}
        </p>
        <button
          className="btn"
          onClick={async () => {
            const id = await seedDemo();
            toast(t('settings.demoCreated'));
            window.location.hash = `#/t/${id}`;
          }}
        >
          {t('settings.demoBtn')}
        </button>
      </section>

      <section className="card card-pad stack">
        <h3 style={{ color: 'var(--danger)' }}>{t('settings.wipe')}</h3>
        <p className="muted" style={{ fontSize: 14 }}>
          {t('settings.wipeBody')}
        </p>
        <button
          className="btn btn-danger"
          onClick={async () => {
            if (
              await ask(t('settings.wipeQ', { trips: counts.trips, expenses: counts.expenses }), {
                confirmLabel: t('settings.wipeConfirm'),
                danger: true,
              })
            ) {
              await clearAll();
              toast(t('settings.wiped'));
            }
          }}
        >
          {t('settings.wipeBtn')}
        </button>
      </section>

      <p className="tiny settings-foot">{t('settings.footer')}</p>
    </div>
  );
}
