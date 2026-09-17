// Weather — Bureau of Meteorology AWS observations (keyless JSON).
// Region-aware: each region points at its local BoM product. Canberra Airport
// (IDN60903.94926) is the default. Latest observation as a point + short trend.

const DEFAULT_PRODUCT = 'https://www.bom.gov.au/fwo/IDN60903/IDN60903.94926.json';

export async function fetchWeather(region) {
  const url = region?.params?.weather?.url || DEFAULT_PRODUCT;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; parallax-demo/0.1)' },
  });
  if (!res.ok) throw new Error(`BoM ${res.status}`);
  const data = await res.json();

  const obs = data?.observations?.data || [];
  const latest = obs[0];
  const features = [];

  if (latest && latest.lon != null && latest.lat != null) {
    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [latest.lon, latest.lat] },
      properties: {
        layer: 'weather', title: latest.name || 'Weather station',
        air_temp: latest.air_temp, apparent_t: latest.apparent_t,
        wind_dir: latest.wind_dir, wind_spd_kmh: latest.wind_spd_kmh,
        gust_kmh: latest.gust_kmh, rel_humidity: latest.rel_hum,
        rain_trace: latest.rain_trace, press: latest.press,
        observed: latest.local_date_time_full,
      },
    });
  }

  const trend = obs.slice(0, 12).reverse().map((o) => ({ t: o.local_date_time_full, temp: o.air_temp, wind: o.wind_spd_kmh }));
  return { type: 'FeatureCollection', features, trend, generated: Date.now() };
}
