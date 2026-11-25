import { isValidLatLng } from './places';

export function googleMapsDirectionsUrl(lat: unknown, lng: unknown): string | null {
  if (!isValidLatLng(lat, lng)) return null;
  const params = new URLSearchParams({
    api: '1',
    destination: `${Number(lat)},${Number(lng)}`,
  });
  return `https://www.google.com/maps/dir/?${params.toString()}`;
}
