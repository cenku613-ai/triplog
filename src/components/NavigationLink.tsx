import { googleMapsDirectionsUrl } from '../lib/navigation';
import { useI18n } from '../i18n';

export function NavigationLink({
  lat,
  lng,
  title,
  compact = false,
}: {
  lat: unknown;
  lng: unknown;
  title: string;
  compact?: boolean;
}) {
  const { t } = useI18n();
  const href = googleMapsDirectionsUrl(lat, lng);
  if (!href) return null;
  const label = t('map.navigateAria', { title });
  return (
    <a
      href={href}
      className={`google-nav-link${compact ? ' google-nav-compact icon-btn' : ' google-nav-item'}`}
      target="_blank"
      rel="noopener noreferrer"
      title={label}
      aria-label={label}
    >
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" aria-hidden="true">
        <path d="m21 3-7.4 18-3.35-7.25L3 10.4 21 3Z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
        <path d="m10.25 13.75 5.1-5.1" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      </svg>
      {compact ? null : <span>{t('map.navigate')}</span>}
    </a>
  );
}
