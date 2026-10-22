/**
 * Mock commerce data + policy.
 *
 * Everything the agent "knows" about orders, catalog SKUs and refund policy
 * lives here so the demo is fully self-contained (no external APIs).
 */

export interface CatalogItem {
  sku: string;
  name: string;
  price: number;
  /** Keyword groups that identify this product in free-form customer text. */
  aliases: string[][];
}

export interface MockOrder {
  orderId: string;
  customer: string;
  email: string;
  placedAt: string;
  status: 'Processing' | 'Packed' | 'Shipped' | 'Out for delivery' | 'Delivered' | 'Refunded';
  carrier: string;
  tracking: string;
  eta: string;
  items: Array<{ sku: string; qty: number; price: number }>;
  total: number;
}

export const CATALOG: CatalogItem[] = [
  {
    sku: 'SHOE-BLU-01',
    name: 'AeroFlex Blue Running Shoes',
    price: 129,
    aliases: [
      ['blue', 'shoe'],
      ['blue', 'sneaker'],
      ['blue', 'running'],
      ['aero'],
    ],
  },
  {
    sku: 'SHOE-WHT-02',
    name: 'CloudStep White Sneakers',
    price: 115,
    aliases: [
      ['white', 'shoe'],
      ['white', 'sneaker'],
      ['cloudstep'],
    ],
  },
  {
    sku: 'AUD-HDPH-01',
    name: 'QuietWave Noise-Cancelling Headphones',
    price: 249,
    aliases: [
      ['noise', 'headphone'],
      ['headphone'],
      ['headset'],
      ['earphone'],
    ],
  },
  {
    sku: 'DIS-MON-4K',
    name: 'VistaPro 27" 4K Monitor',
    price: 389,
    aliases: [
      ['4k', 'monitor'],
      ['monitor'],
      ['screen'],
      ['display'],
    ],
  },
  {
    sku: 'KEY-MECH-77',
    name: 'TactilePro Mechanical Keyboard',
    price: 159,
    aliases: [
      ['mechanical', 'keyboard'],
      ['keyboard'],
    ],
  },
  {
    sku: 'BAG-TRV-09',
    name: 'Nomad 28L Travel Backpack',
    price: 89,
    aliases: [
      ['travel', 'backpack'],
      ['backpack'],
      ['rucksack'],
    ],
  },
  {
    sku: 'FIT-YOGA-03',
    name: 'AlignFlow Pro Yoga Mat',
    price: 49,
    aliases: [
      ['yoga', 'mat'],
      ['yoga'],
    ],
  },
];

export const ORDERS: MockOrder[] = [
  {
    orderId: '99482',
    customer: 'Ava Mitchell',
    email: 'ava.mitchell@example.com',
    placedAt: '2026-10-16',
    status: 'Out for delivery',
    carrier: 'DHL Express',
    tracking: 'DHL773420199',
    eta: 'Today, before 8:00 PM',
    items: [{ sku: 'SHOE-BLU-01', qty: 1, price: 129 }],
    total: 129,
  },
  {
    orderId: '0000',
    customer: 'M. Renard',
    email: 'm.renard@example.com',
    placedAt: '2026-10-02',
    status: 'Delivered',
    carrier: 'FedEx Priority',
    tracking: 'FDX99201174',
    eta: 'Delivered 15 Oct 2026',
    items: [
      { sku: 'DIS-MON-4K', qty: 2, price: 2500 },
      { sku: 'KEY-MECH-77', qty: 1, price: 0 },
    ],
    total: 5000,
  },
  {
    orderId: '10231',
    customer: 'Devon Clarke',
    email: 'devon.clarke@example.com',
    placedAt: '2026-10-11',
    status: 'Shipped',
    carrier: 'UPS Ground',
    tracking: 'UPS55400921',
    eta: 'Tomorrow by 6:00 PM',
    items: [{ sku: 'SHOE-WHT-02', qty: 1, price: 115 }],
    total: 115,
  },
  {
    orderId: '77841',
    customer: 'Priya Nair',
    email: 'priya.nair@example.com',
    placedAt: '2026-09-29',
    status: 'Delivered',
    carrier: 'USPS',
    tracking: 'USPS33018822',
    eta: 'Delivered 06 Oct 2026',
    items: [{ sku: 'AUD-HDPH-01', qty: 1, price: 249 }],
    total: 249,
  },
  {
    orderId: '55012',
    customer: 'Tomas Berg',
    email: 'tomas.berg@example.com',
    placedAt: '2026-09-20',
    status: 'Delivered',
    carrier: 'DHL Express',
    tracking: 'DHL77001022',
    eta: 'Delivered 27 Sep 2026',
    items: [{ sku: 'BAG-TRV-09', qty: 1, price: 89 }],
    total: 89,
  },
];

export const POLICY = {
  /** Days after delivery during which a refund may be self-issued. */
  returnWindowDays: 30,
  /** Refunds above this amount require a human agent. */
  autoRefundCeilingUsd: 500,
  /** Maximum number of refunds per customer per 24h before fraud review. */
  refundVelocityLimit: 3,
  supportHours: 'Mon–Fri 08:00–20:00 ET',
} as const;

/* ------------------------------------------------------------------ */
/* Lookup helpers                                                      */
/* ------------------------------------------------------------------ */

export function findOrder(orderId: string): MockOrder | undefined {
  const needle = orderId.trim().replace(/^#/, '').toLowerCase();
  return ORDERS.find((o) => o.orderId.toLowerCase() === needle);
}

export function findCatalogItem(sku: string): CatalogItem | undefined {
  const needle = sku.trim().toLowerCase();
  return CATALOG.find((c) => c.sku.toLowerCase() === needle);
}

/**
 * Resolve a product mention in free-form text to a catalog SKU.
 * Every alias keyword must be present for a match, which keeps the
 * grounding check deliberately conservative.
 */
export function resolveProductToSku(text: string): CatalogItem | undefined {
  const haystack = ` ${text.toLowerCase()} `;
  for (const item of CATALOG) {
    for (const alias of item.aliases) {
      const hit = alias.every((kw) => haystack.includes(` ${kw}`) || haystack.includes(`${kw} `));
      if (hit) return item;
    }
  }
  return undefined;
}
