function cleanText(value, maxLength = 120) {
  if (typeof value !== 'string') return null;
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return cleaned ? cleaned.slice(0, maxLength) : null;
}

function roundedCoordinate(value, min, max) {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) return null;
  // Cloudflare IP geolocation is approximate; store only a coarse city-scale point.
  return Math.round(number * 10) / 10;
}

export function getApproximateCloudflareLocation(cf) {
  const countryCandidate = cleanText(cf?.country, 3);
  return {
    city: cleanText(cf?.city),
    region: cleanText(cf?.region),
    country: countryCandidate && /^[A-Za-z]{2}$/.test(countryCandidate)
      ? countryCandidate.toUpperCase()
      : null,
    latitude: roundedCoordinate(cf?.latitude, -90, 90),
    longitude: roundedCoordinate(cf?.longitude, -180, 180),
  };
}
