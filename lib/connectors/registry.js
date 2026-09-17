// Connector registry — add a data source by writing one connector file and
// listing it here. It then flows automatically into the feed cache + poller,
// the snapshot/replay store, the layer list, and (via region.layers) the map.

import { eonetConnector } from './sources/eonet.js';
import { facilitiesConnector } from './sources/facilities.js';
import { berthsConnector } from './sources/berths.js';

export const CONNECTORS = [
  eonetConnector,      // api      — NASA EONET natural events
  facilitiesConnector, // datalake — facilities register
  berthsConnector,     // datalake — berths, wharves and terminals
];
