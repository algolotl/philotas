// Approximate country centroids [lon, lat], keyed by lowercased country name.
// Used to place worldwide news by GDELT `sourcecountry` when there's no single
// regional anchor. Indicative, not surveyed.

const CENTROIDS = {
  'united states': [-98.5, 39.8], 'united kingdom': [-1.5, 52.6], 'australia': [134.5, -25.7],
  'canada': [-106.3, 56.1], 'china': [104.2, 35.9], 'india': [78.9, 20.6], 'japan': [138.3, 36.2],
  'germany': [10.4, 51.2], 'france': [2.2, 46.6], 'italy': [12.6, 41.9], 'spain': [-3.7, 40.2],
  'russia': [105.3, 61.5], 'brazil': [-51.9, -14.2], 'mexico': [-102.6, 23.6], 'argentina': [-65.2, -38.4],
  'south africa': [22.9, -30.6], 'egypt': [30.8, 26.8], 'nigeria': [8.7, 9.1], 'kenya': [37.9, -0.0],
  'saudi arabia': [45.1, 23.9], 'united arab emirates': [53.8, 23.4], 'israel': [34.9, 31.0],
  'turkey': [35.2, 38.9], 'iran': [53.7, 32.4], 'iraq': [43.7, 33.2], 'pakistan': [69.3, 30.4],
  'bangladesh': [90.4, 23.7], 'indonesia': [113.9, -0.8], 'malaysia': [101.9, 4.2], 'singapore': [103.8, 1.35],
  'thailand': [100.9, 15.9], 'vietnam': [108.3, 14.1], 'philippines': [122.9, 12.9], 'south korea': [127.8, 36.4],
  'north korea': [127.5, 40.3], 'new zealand': [172.5, -41.8], 'ireland': [-8.2, 53.4], 'netherlands': [5.3, 52.1],
  'belgium': [4.5, 50.6], 'switzerland': [8.2, 46.8], 'austria': [14.5, 47.6], 'sweden': [16.7, 62.2],
  'norway': [9.0, 61.4], 'denmark': [9.5, 56.1], 'finland': [25.7, 64.5], 'poland': [19.1, 51.9],
  'ukraine': [31.2, 48.4], 'greece': [21.8, 39.1], 'portugal': [-8.2, 39.6], 'czech republic': [15.5, 49.8],
  'hungary': [19.5, 47.2], 'romania': [25.0, 45.9], 'colombia': [-73.1, 4.6], 'venezuela': [-66.6, 6.4],
  'peru': [-75.0, -9.2], 'chile': [-71.5, -35.7], 'cuba': [-79.0, 21.6], 'qatar': [51.2, 25.3],
  'kuwait': [47.6, 29.3], 'jordan': [36.2, 31.3], 'lebanon': [35.9, 33.9], 'syria': [38.0, 35.0],
  'afghanistan': [66.0, 33.9], 'sri lanka': [80.7, 7.9], 'nepal': [84.1, 28.4], 'myanmar': [96.0, 21.9],
  'ethiopia': [39.6, 8.6], 'ghana': [-1.0, 7.9], 'morocco': [-7.1, 31.8], 'algeria': [2.6, 28.0],
  'tunisia': [9.6, 34.0], 'libya': [17.2, 26.3], 'sudan': [30.2, 16.0], 'tanzania': [34.9, -6.4],
  'uganda': [32.3, 1.4], 'zimbabwe': [29.2, -19.0], 'taiwan': [120.9, 23.7], 'hong kong': [114.1, 22.4],
};

export function centroidFor(country) {
  if (!country) return null;
  return CENTROIDS[country.toLowerCase().trim()] || null;
}
