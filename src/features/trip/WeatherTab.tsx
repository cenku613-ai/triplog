import { useEffect, useMemo, useState } from 'react';
import type { DayItem, Trip } from '../../db/types';
import { Empty } from '../../components/Controls';
import { dayIndex, dayLabel, prettyDate, today } from '../../lib/dates';
import { useI18n, type Key } from '../../i18n';
import {
  buildWeatherPlan,
  loadWeather,
  type WeatherErrorKind,
  type WeatherLocation,
  type WeatherLocationState,
} from '../../lib/weather';

export function WeatherTab({
  trip,
  items,
  onAddLocation,
}: {
  trip: Trip;
  items: DayItem[];
  onAddLocation: () => void;
}) {
  const { t, locale } = useI18n();
  const plan = useMemo(() => buildWeatherPlan(trip, items), [trip, items]);
  const [results, setResults] = useState<Record<string, WeatherLocationState>>({});
  const [reload, setReload] = useState(0);

  useEffect(() => {
    if (!plan.activeLocations.length) {
      setResults({});
      return;
    }
    const controller = new AbortController();
    setResults({});
    loadWeather(plan.activeLocations, plan.window, controller.signal, reload > 0)
      .then((next) => {
        if (!controller.signal.aborted) setResults(next);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        const kind = error && typeof error === 'object' && 'kind' in error ? (error.kind as WeatherErrorKind) : 'offline';
        setResults(Object.fromEntries(plan.activeLocations.map((p) => [p.key, { status: 'error', error: kind }])));
      });
    return () => controller.abort();
  }, [plan, reload]);

  const loading = plan.activeLocations.some((p) => !results[p.key]);
  const updatedAt = Object.values(results).find(
    (state): state is Extract<WeatherLocationState, { status: 'ready' | 'stale' }> => state.status === 'ready' || state.status === 'stale',
  )?.forecast.fetchedAt;

  return (
    <section className="weather-tab" aria-label={t('tab.weather')}>
      <div className="card card-pad weather-head">
        <div className="row-between wrap">
          <div className="grow" style={{ minWidth: 220 }}>
            <h2>{t('weather.title')}</h2>
            <p className="tiny" style={{ marginTop: 4, lineHeight: 1.7 }}>
              {t('weather.hint')}
            </p>
          </div>
          <button className="btn btn-sm" onClick={() => setReload((n) => n + 1)} disabled={loading}>
            <span className={loading ? 'spin' : ''} aria-hidden="true">↻</span>
            {loading ? t('weather.loading') : t('weather.refresh')}
          </button>
        </div>
        <div className="row wrap tiny" style={{ marginTop: 'var(--sp-3)', gap: 'var(--sp-3)' }}>
          <span>{t('weather.horizon')}</span>
          {updatedAt ? <span>{t('weather.updated', { time: formatUpdated(updatedAt, locale) })}</span> : null}
        </div>
      </div>

      {!plan.locations.length ? (
        <Empty
          icon="☁"
          title={t('weather.noLocations')}
          body={t('weather.noLocationsBody')}
          action={
            <button className="btn btn-primary" onClick={onAddLocation}>
              {t('weather.addLocation')}
            </button>
          }
        />
      ) : !plan.window ? (
        <Empty icon="◷" title={t('weather.outsideTitle')} body={t('weather.outsideBody')} />
      ) : (
        <div className="weather-days">
          {plan.days.map((day) => (
            <section className="card weather-day" key={day.date} aria-label={prettyDate(day.date)}>
              <div className="weather-day-head">
                <div>
                  <h3>
                    {dayLabel(dayIndex(trip.startDate, day.date) ?? 1)} · {prettyDate(day.date)}
                  </h3>
                  <span className="tiny">{day.date < today() ? t('weather.past') : t('weather.forecast')}</span>
                </div>
                <span className="badge">{t('weather.locationCount', { n: day.locations.length })}</span>
              </div>
              {!day.locations.length ? (
                <p className="tiny weather-day-empty">{t('weather.dayNoLocation')}</p>
              ) : (
                <div className="weather-locations">
                  {day.locations.map((location) => (
                    <LocationWeather
                      key={location.key}
                      date={day.date}
                      location={location}
                      state={results[location.key] ?? { status: 'loading' }}
                      available={day.date >= plan.window!.start && day.date <= plan.window!.end}
                    />
                  ))}
                </div>
              )}
            </section>
          ))}
        </div>
      )}

      <p className="tiny weather-credit">
        {t('weather.credit')}{' '}
        <a href="https://open-meteo.com/" target="_blank" rel="noreferrer">
          Open-Meteo
        </a>{' '}
        · CC BY 4.0
      </p>
      {loading ? <p className="tiny" role="status">{t('weather.loading')}</p> : null}
    </section>
  );
}

function formatUpdated(at: number, locale: string): string {
  return new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(at);
}

function LocationWeather({
  date,
  location,
  state,
  available,
}: {
  date: string;
  location: WeatherLocation;
  state: WeatherLocationState;
  available: boolean;
}) {
  const { t, locale } = useI18n();
  if (!available) {
    return (
      <article className="weather-location is-unavailable">
        <h4>{location.name}</h4>
        <p className="tiny">{t('weather.unavailable')}</p>
      </article>
    );
  }
  if (state.status === 'loading') {
    return (
      <article className="weather-location" aria-busy="true">
        <h4>{location.name}</h4>
        <div className="weather-loading"><span className="spin" aria-hidden="true">◌</span> {t('weather.loading')}</div>
      </article>
    );
  }
  if (state.status === 'error') {
    return (
      <article className="weather-location is-error">
        <h4>{location.name}</h4>
        <p className="tiny" role="status">{t(errorKey(state.error))}</p>
      </article>
    );
  }
  const day = state.forecast.days.find((row) => row.date === date);
  if (!day) {
    return (
      <article className="weather-location is-unavailable">
        <h4>{location.name}</h4>
        <p className="tiny">{t('weather.noData')}</p>
      </article>
    );
  }
  return (
    <article className="weather-location">
      <div className="row-between wrap" style={{ gap: 6 }}>
        <h4>{location.name}</h4>
        {state.status === 'stale' ? (
          <span className="badge">{t('weather.cached', { time: formatUpdated(state.forecast.fetchedAt, locale) })}</span>
        ) : null}
      </div>
      <div className="weather-main">
        <WeatherIcon code={day.code} />
        <div className="grow" style={{ minWidth: 0 }}>
          <div className="weather-condition">{t(conditionKey(day.code))}</div>
          <div className="weather-temp">
            <strong>{temperature(day.tempMax, locale)}°</strong>
            <span>{temperature(day.tempMin, locale)}°</span>
          </div>
        </div>
      </div>
      <div className="weather-metrics">
        <span>{t('weather.rain', { n: number(day.rainChance, locale, 0) })}</span>
        <span>{t('weather.precipitation', { n: number(day.precipitation, locale) })}</span>
        <span>{t('weather.wind', { n: number(day.windMax, locale) })}</span>
      </div>
      <div className="tiny weather-zone">{state.forecast.timezone.replaceAll('_', ' ')}</div>
    </article>
  );
}

function number(value: number | null, locale: string, digits = 1): string {
  return value === null ? '—' : new Intl.NumberFormat(locale, { maximumFractionDigits: digits }).format(value);
}

function temperature(value: number | null, locale: string): string {
  return value === null ? '—' : new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(value);
}

function errorKey(kind: WeatherErrorKind): Key {
  return (
    {
      offline: 'weather.errOffline',
      rate: 'weather.errRate',
      http: 'weather.errHttp',
      parse: 'weather.errParse',
      timeout: 'weather.errTimeout',
      aborted: 'weather.errHttp',
    } as const
  )[kind];
}

function conditionKey(code: number): Key {
  if (code === 0) return 'weather.code.clear';
  if (code === 1) return 'weather.code.mainlyClear';
  if (code === 2) return 'weather.code.partlyCloudy';
  if (code === 3) return 'weather.code.overcast';
  if (code === 45 || code === 48) return 'weather.code.fog';
  if (code === 51) return 'weather.code.lightDrizzle';
  if (code === 53) return 'weather.code.drizzle';
  if (code === 55) return 'weather.code.denseDrizzle';
  if (code === 56 || code === 57) return 'weather.code.freezingDrizzle';
  if (code === 61) return 'weather.code.lightRain';
  if (code === 63) return 'weather.code.rain';
  if (code === 65) return 'weather.code.heavyRain';
  if (code === 66 || code === 67) return 'weather.code.freezingRain';
  if (code === 71) return 'weather.code.lightSnow';
  if (code === 73) return 'weather.code.snow';
  if (code === 75) return 'weather.code.heavySnow';
  if (code === 77) return 'weather.code.snowGrains';
  if (code === 80) return 'weather.code.lightShowers';
  if (code === 81) return 'weather.code.showers';
  if (code === 82) return 'weather.code.violentShowers';
  if (code === 85) return 'weather.code.lightSnowShowers';
  if (code === 86) return 'weather.code.snowShowers';
  if (code === 95 || code === 96) return 'weather.code.thunderstorm';
  return 'weather.code.heavyThunderstorm';
}

function WeatherIcon({ code }: { code: number }) {
  const sunny = code <= 1;
  const partly = code === 2;
  const cloudy = code === 3 || code === 45 || code === 48;
  const fog = code === 45 || code === 48;
  const drizzle = (code >= 51 && code <= 57) || (code >= 80 && code <= 82);
  const rain = (code >= 61 && code <= 67) || drizzle;
  const snow = (code >= 71 && code <= 77) || (code >= 85 && code <= 86);
  const storm = code >= 95;
  const showCloud = partly || cloudy || rain || snow || storm;
  return (
    <svg className={`weather-icon${storm ? ' is-storm' : ''}${rain || snow ? ' is-wet' : ''}`} viewBox="0 0 48 48" aria-hidden="true">
      {sunny || partly ? (
        <g className="weather-sun">
          <circle cx="17" cy="16" r="6" />
          <path d="M17 4v3M17 25v3M5 16h3M26 16h3M8.5 7.5l2 2M23.5 22.5l2 2M8.5 24.5l2-2M23.5 9.5l2-2" />
        </g>
      ) : null}
      {showCloud ? (
        <path className="weather-cloud" d="M13 35a8 8 0 0 1-1-16 11 11 0 0 1 21-2 9 9 0 0 1 1 18Z" />
      ) : null}
      {fog ? <path className="weather-fog" d="M10 39h28M15 44h18" /> : null}
      {drizzle ? <path className="weather-rain" d="m15 39-2 4m12-4-2 4m12-4-2 4" /> : null}
      {rain && !drizzle ? <path className="weather-rain" d="m14 38-3 7m13-7-3 7m13-7-3 7" /> : null}
      {snow ? <path className="weather-snow" d="M14 40v6m-3-3h6m10-3v6m-3-3h6m10-3v6m-3-3h6" /> : null}
      {storm ? <path className="weather-bolt" d="m25 33-6 9h6l-2 7 10-12h-6l3-4Z" /> : null}
    </svg>
  );
}
