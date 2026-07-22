/**
 * Populate Sync2Dine Demo Kitchen with menu, CRM customers, extra staff, and orders.
 *
 * Usage:
 *   npx tsx --env-file=.env scripts/populate-demo-restaurant.ts
 */
import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'crypto';

const SEED_PASSWORD = process.env.SEED_PASSWORD?.trim() || 'Sync2DineDemo1!';
const ORG_NAME = 'Sync2Dine Demo Kitchen';
const ORG_HINT_EMAIL = 'maya@demo.sync2dine.io';

type StaffSeed = {
  email: string;
  username: string;
  name: string;
  role: 'staff' | 'manager';
};

const EXTRA_STAFF: StaffSeed[] = [
  { email: 'sam.wait@demo.sync2dine.io', username: 'sam.wait', name: 'Sam Wait', role: 'staff' },
  { email: 'jordan.till@demo.sync2dine.io', username: 'jordan.till', name: 'Jordan Till', role: 'staff' },
  { email: 'alex.floor@demo.sync2dine.io', username: 'alex.floor', name: 'Alex Floor', role: 'manager' },
];

const MENU = [
  // Starters
  { id: 'food-onion-bhaji', name: 'Onion bhaji', sellPrice: 3.5, category: 'starters', allergensContains: ['gluten'], dietary: ['vegetarian'], allergenDeclared: true },
  { id: 'food-veg-samosa', name: 'Veg samosa (2)', sellPrice: 3.2, category: 'starters', allergensContains: ['gluten'], dietary: ['vegetarian'], allergenDeclared: true },
  { id: 'food-meat-samosa', name: 'Meat samosa (2)', sellPrice: 3.8, category: 'starters', allergensContains: ['gluten'], dietary: ['halal'], allergenDeclared: true },
  { id: 'food-chicken-pakora', name: 'Chicken pakora', sellPrice: 4.5, category: 'starters', allergensContains: ['gluten'], dietary: ['halal'], allergenDeclared: true },
  { id: 'food-paneer-pakora', name: 'Paneer pakora', sellPrice: 4.2, category: 'starters', allergensContains: ['milk', 'gluten'], dietary: ['vegetarian'], allergenDeclared: true },
  { id: 'food-mixed-starter', name: 'Mixed starter platter', sellPrice: 8.5, category: 'starters', allergensContains: ['gluten', 'milk'], allergenDeclared: true },
  // Mains
  { id: 'food-chicken-biryani', name: 'Chicken biryani', sellPrice: 9.5, category: 'mains', allergensContains: ['milk'], allergensMayContain: ['nuts'], allergenDeclared: true },
  { id: 'food-lamb-biryani', name: 'Lamb biryani', sellPrice: 10.5, category: 'mains', allergensContains: ['milk'], dietary: ['halal'], allergenDeclared: true },
  { id: 'food-lamb-curry', name: 'Lamb curry', sellPrice: 10.5, category: 'mains', allergensContains: ['milk'], dietary: ['halal'], allergenDeclared: true },
  { id: 'food-butter-chicken', name: 'Butter chicken', sellPrice: 11.0, category: 'mains', allergensContains: ['milk', 'nuts'], allergenDeclared: true },
  { id: 'food-chicken-tikka-masala', name: 'Chicken tikka masala', sellPrice: 10.5, category: 'mains', allergensContains: ['milk'], allergenDeclared: true },
  { id: 'food-chicken-jalfrezi', name: 'Chicken jalfrezi', sellPrice: 10.0, category: 'mains', allergensContains: [] as string[], allergenDeclared: true },
  { id: 'food-lamb-rogan-josh', name: 'Lamb rogan josh', sellPrice: 11.5, category: 'mains', allergensContains: ['milk'], dietary: ['halal'], allergenDeclared: true },
  { id: 'food-paneer-tikka', name: 'Paneer tikka', sellPrice: 9.0, category: 'mains', allergensContains: ['milk'], dietary: ['vegetarian'], allergenDeclared: true },
  { id: 'food-chana-masala', name: 'Chana masala', sellPrice: 8.0, category: 'mains', allergensContains: [] as string[], dietary: ['vegan', 'vegetarian'], allergenDeclared: true },
  { id: 'food-dal-makhani', name: 'Dal makhani', sellPrice: 8.5, category: 'mains', allergensContains: ['milk'], dietary: ['vegetarian'], allergenDeclared: true },
  { id: 'food-fish-curry', name: 'Fish curry', sellPrice: 11.0, category: 'mains', allergensContains: ['fish'], allergenDeclared: true },
  { id: 'food-keema-peas', name: 'Keema peas', sellPrice: 9.5, category: 'mains', allergensContains: [] as string[], dietary: ['halal'], allergenDeclared: true },
  // Sides
  { id: 'food-garlic-naan', name: 'Garlic naan', sellPrice: 2.5, category: 'sides', allergensContains: ['gluten', 'milk'], allergenDeclared: true },
  { id: 'food-plain-naan', name: 'Plain naan', sellPrice: 2.0, category: 'sides', allergensContains: ['gluten', 'milk'], allergenDeclared: true },
  { id: 'food-peshwari-naan', name: 'Peshwari naan', sellPrice: 3.0, category: 'sides', allergensContains: ['gluten', 'milk', 'nuts'], allergenDeclared: true },
  { id: 'food-pilau-rice', name: 'Pilau rice', sellPrice: 2.8, category: 'sides', allergensContains: [] as string[], allergenDeclared: true },
  { id: 'food-plain-rice', name: 'Boiled rice', sellPrice: 2.2, category: 'sides', allergensContains: [] as string[], dietary: ['vegan'], allergenDeclared: true },
  { id: 'food-chips', name: 'Chips', sellPrice: 2.5, category: 'sides', allergensContains: [] as string[], allergenDeclared: true },
  { id: 'food-raita', name: 'Raita', sellPrice: 2.0, category: 'sides', allergensContains: ['milk'], dietary: ['vegetarian'], allergenDeclared: true },
  { id: 'food-mango-chutney', name: 'Mango chutney', sellPrice: 1.5, category: 'sides', allergensContains: [] as string[], dietary: ['vegan'], allergenDeclared: true },
  // Drinks
  { id: 'food-mango-lassi', name: 'Mango lassi', sellPrice: 3.0, category: 'drinks', allergensContains: ['milk'], dietary: ['vegetarian'], allergenDeclared: true },
  { id: 'food-coke', name: 'Coke', sellPrice: 1.8, category: 'drinks', allergensContains: [] as string[], allergenDeclared: true },
  { id: 'food-diet-coke', name: 'Diet Coke', sellPrice: 1.8, category: 'drinks', allergensContains: [] as string[], allergenDeclared: true },
  { id: 'food-sprite', name: 'Sprite', sellPrice: 1.8, category: 'drinks', allergensContains: [] as string[], allergenDeclared: true },
  { id: 'food-water', name: 'Still water', sellPrice: 1.2, category: 'drinks', allergensContains: [] as string[], dietary: ['vegan'], allergenDeclared: true },
  // Desserts
  { id: 'food-gulab-jamun', name: 'Gulab jamun', sellPrice: 3.5, category: 'desserts', allergensContains: ['milk', 'gluten'], dietary: ['vegetarian'], allergenDeclared: true },
  { id: 'food-kheer', name: 'Rice kheer', sellPrice: 3.5, category: 'desserts', allergensContains: ['milk'], dietary: ['vegetarian'], allergenDeclared: true },
  { id: 'food-ice-cream', name: 'Ice cream scoop', sellPrice: 2.5, category: 'desserts', allergensContains: ['milk'], dietary: ['vegetarian'], allergenDeclared: true },
  // Meal deals
  {
    id: 'food-mile-a-meal',
    name: 'Mile a Meal',
    sellPrice: 12.5,
    category: 'specials',
    description: '1 main + 1 side + 1 drink',
    deal: {
      roles: [
        { role: 'main', qtyPerDeal: 1, choices: ['Chicken biryani', 'Butter chicken', 'Lamb curry', 'Paneer tikka', 'Chicken tikka masala', 'Chana masala'] },
        { role: 'side', qtyPerDeal: 1, choices: ['Pilau rice', 'Chips', 'Garlic naan', 'Boiled rice'] },
        { role: 'drink', qtyPerDeal: 1, choices: ['Coke', 'Diet Coke', 'Sprite', 'Mango lassi'] },
      ],
    },
  },
  {
    id: 'food-family-feast',
    name: 'Family Feast',
    sellPrice: 32.0,
    category: 'specials',
    description: '2 mains + 2 sides + 2 drinks',
    deal: {
      roles: [
        { role: 'main', qtyPerDeal: 2, choices: ['Chicken biryani', 'Butter chicken', 'Lamb curry', 'Lamb biryani', 'Paneer tikka'] },
        { role: 'side', qtyPerDeal: 2, choices: ['Pilau rice', 'Chips', 'Garlic naan', 'Plain naan'] },
        { role: 'drink', qtyPerDeal: 2, choices: ['Coke', 'Diet Coke', 'Sprite', 'Mango lassi'] },
      ],
    },
  },
];

const CUSTOMERS = [
  {
    id: 'C-DEMO-001',
    name: 'Amelia Hart',
    email: 'amelia.hart@example.test',
    phone: '07700900101',
    address: '12 Market Street, London',
    status: 'won',
    notes: 'Regular Friday collection',
  },
  {
    id: 'C-DEMO-002',
    name: 'Ben Okonkwo',
    email: 'ben.okonkwo@example.test',
    phone: '07700900102',
    address: '44 High Road, London',
    status: 'active',
    notes: 'Prefers delivery, no nuts',
  },
  {
    id: 'C-DEMO-003',
    name: 'Chloe Nguyen',
    email: 'chloe.nguyen@example.test',
    phone: '07700900103',
    address: '8 Bridge Lane, London',
    status: 'won',
    notes: 'Office lunch orders',
  },
  {
    id: 'C-DEMO-004',
    name: 'Daniel Rossi',
    email: 'daniel.rossi@example.test',
    phone: '07700900104',
    address: '21 Park Avenue, London',
    status: 'lead',
    notes: 'Tried kiosk once',
  },
  {
    id: 'C-DEMO-005',
    name: 'Elena Popescu',
    email: 'elena.popescu@example.test',
    phone: '07700900105',
    address: '3 Station Close, London',
    status: 'won',
    notes: 'Romanian — spice mild',
  },
  {
    id: 'C-DEMO-006',
    name: 'Farah Ali',
    email: 'farah.ali@example.test',
    phone: '07700900106',
    address: '19 Canal Walk, London',
    status: 'active',
    notes: 'Halal only',
  },
  {
    id: 'C-DEMO-007',
    name: 'Grace Miller',
    email: 'grace.miller@example.test',
    phone: '07700900107',
    address: '55 Queen Street, London',
    status: 'won',
    notes: 'Family of 4, weekend delivery',
  },
  {
    id: 'C-DEMO-008',
    name: 'Hassan Khan',
    email: 'hassan.khan@example.test',
    phone: '07700900108',
    address: '2 Riverside, London',
    status: 'active',
    notes: 'Large party orders',
  },
  {
    id: 'C-DEMO-009',
    name: 'Huge Party Delivery',
    email: 'huge.party@example.test',
    phone: '07700900109',
    address: '100 Festival Road, London E1 6AN',
    status: 'active',
    notes: 'QA: multi-item delivery (~15 lines) + meal deals',
  },
];

function admin() {
  const url = process.env.SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

async function resolveOrgId(supabase: ReturnType<typeof admin>): Promise<string> {
  const { data } = await supabase
    .from('organizations')
    .select('id, name')
    .or(`name.eq.${ORG_NAME},contact_email.eq.${ORG_HINT_EMAIL}`)
    .limit(1)
    .maybeSingle();
  if (!data?.id) throw new Error(`Org not found: ${ORG_NAME}. Run npm run seed:accounts first.`);
  console.log(`[populate] Org ${data.id} (${data.name})`);
  return data.id;
}

async function upsertMenu(supabase: ReturnType<typeof admin>, orgId: string) {
  const now = new Date().toISOString();
  const rows = MENU.map((item) => {
    const extra = item as {
      description?: string;
      deal?: { roles: Array<{ role: string; qtyPerDeal: number; choices: string[] }> };
      allergensContains?: string[];
      allergensMayContain?: string[];
      dietary?: string[];
      allergenNotes?: string;
      allergenDeclared?: boolean;
    };
    return {
      id: item.id,
      org_id: orgId,
      data: {
        name: item.name,
        image: '',
        basePrice: item.sellPrice,
        margin: 0,
        sellPrice: item.sellPrice,
        price: item.sellPrice,
        source: 'restaurant',
        category: item.category,
        tradeId: null,
        available: true,
        ...(extra.description ? { description: extra.description } : {}),
        ...(extra.deal ? { deal: extra.deal } : {}),
        ...(extra.allergensContains ? { allergensContains: extra.allergensContains } : {}),
        ...(extra.allergensMayContain ? { allergensMayContain: extra.allergensMayContain } : {}),
        ...(extra.dietary ? { dietary: extra.dietary } : {}),
        ...(extra.allergenNotes ? { allergenNotes: extra.allergenNotes } : {}),
        ...(extra.allergenDeclared ? { allergenDeclared: true } : {}),
      },
      updated_at: now,
    };
  });
  const { error } = await supabase.from('products').upsert(rows, { onConflict: 'org_id,id' });
  if (error) throw new Error(`products: ${error.message}`);
  console.log(`[populate] Menu items: ${rows.length}`);
}

async function upsertCustomers(supabase: ReturnType<typeof admin>, orgId: string) {
  const now = new Date().toISOString();
  const rows = CUSTOMERS.map((c) => ({
    id: c.id,
    org_id: orgId,
    data: {
      name: c.name,
      email: c.email,
      phone: c.phone,
      address: c.address,
      status: c.status,
      createdAt: now,
      photos: [],
      notes: c.notes,
      whatsappOptIn: true,
      preferredChannel: 'phone',
      preferredLanguage: 'en',
    },
    updated_at: now,
  }));
  const { error } = await supabase.from('customers').upsert(rows, { onConflict: 'org_id,id' });
  if (error) throw new Error(`customers: ${error.message}`);
  console.log(`[populate] CRM customers: ${rows.length}`);
}

async function ensureStaffUser(
  supabase: ReturnType<typeof admin>,
  staff: StaffSeed,
  orgId: string,
): Promise<'created' | 'updated'> {
  const { data: existingProfile } = await supabase
    .from('profiles')
    .select('id')
    .eq('email', staff.email)
    .maybeSingle();

  if (existingProfile?.id) {
    await supabase
      .from('profiles')
      .update({
        name: staff.name,
        username: staff.username,
        role: staff.role,
        org_id: orgId,
        updated_at: new Date().toISOString(),
      })
      .eq('id', existingProfile.id);
    await supabase.auth.admin.updateUserById(existingProfile.id, {
      password: SEED_PASSWORD,
      email_confirm: true,
      user_metadata: {
        name: staff.name,
        username: staff.username,
        role: staff.role,
        org_id: orgId,
      },
    });
    return 'updated';
  }

  const { data, error } = await supabase.auth.admin.createUser({
    email: staff.email,
    password: SEED_PASSWORD,
    email_confirm: true,
    user_metadata: {
      name: staff.name,
      username: staff.username,
      role: staff.role,
      org_id: orgId,
    },
  });
  if (error || !data.user) throw new Error(`Create staff ${staff.email}: ${error?.message}`);
  await supabase.from('profiles').upsert({
    id: data.user.id,
    email: staff.email,
    name: staff.name,
    username: staff.username,
    role: staff.role,
    org_id: orgId,
    updated_at: new Date().toISOString(),
  });
  return 'created';
}

async function seedStaff(supabase: ReturnType<typeof admin>, orgId: string) {
  for (const s of EXTRA_STAFF) {
    const result = await ensureStaffUser(supabase, s, orgId);
    console.log(`[populate] Staff ${s.email} (${s.role}) — ${result}`);
  }
}

async function nextOrderNumber(supabase: ReturnType<typeof admin>, orgId: string): Promise<number> {
  const { data } = await supabase
    .from('orders')
    .select('order_number')
    .eq('org_id', orgId)
    .order('order_number', { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data?.order_number ?? 1000) + 1;
}

async function seedOrders(supabase: ReturnType<typeof admin>, orgId: string) {
  // Avoid flooding: only add demo batch if fewer than 5 demo-tagged orders exist
  const { data: existing } = await supabase
    .from('orders')
    .select('id, notes')
    .eq('org_id', orgId)
    .ilike('notes', '%[demo-seed]%')
    .limit(20);
  if ((existing?.length ?? 0) >= 8) {
    console.log(`[populate] Demo orders already present (${existing!.length}) — ensuring huge-party tickets`);
    await seedHugePartyOrdersIfMissing(supabase, orgId);
    return;
  }

  let n = await nextOrderNumber(supabase, orgId);
  const now = Date.now();
  type SeedItem = {
    name: string;
    qty: number;
    price: number;
    dealName?: string;
    dealIndex?: number;
    role?: string;
  };
  const templates: Array<{
    customer: (typeof CUSTOMERS)[number];
    status: string;
    paymentStatus: string;
    channel: string;
    orderType: string;
    items: SeedItem[];
    minutesAgo: number;
    notes: string;
    deliveryAddress?: string;
    specialName?: string;
  }> = [
    {
      customer: CUSTOMERS[0],
      status: 'new',
      paymentStatus: 'unpaid',
      channel: 'phone',
      orderType: 'collection',
      items: [
        { name: 'Chicken biryani', qty: 2, price: 9.5 },
        { name: 'Garlic naan', qty: 2, price: 2.5 },
      ],
      minutesAgo: 2,
      notes: '[demo-seed] Just rang in — needs till confirm',
    },
    {
      customer: CUSTOMERS[1],
      status: 'paid',
      paymentStatus: 'card',
      channel: 'kiosk',
      orderType: 'collection',
      items: [
        { name: 'Butter chicken', qty: 1, price: 11 },
        { name: 'Pilau rice', qty: 1, price: 2.8 },
        { name: 'Mango lassi', qty: 1, price: 3 },
      ],
      minutesAgo: 8,
      notes: '[demo-seed] Kiosk paid — send to kitchen',
    },
    {
      customer: CUSTOMERS[2],
      status: 'preparing',
      paymentStatus: 'card',
      channel: 'phone',
      orderType: 'delivery',
      items: [
        { name: 'Lamb curry', qty: 2, price: 10.5 },
        { name: 'Onion bhaji', qty: 1, price: 3.5 },
        { name: 'Garlic naan', qty: 3, price: 2.5 },
      ],
      minutesAgo: 18,
      notes: '[demo-seed] Office lunch — kitchen',
      deliveryAddress: CUSTOMERS[2].address,
    },
    {
      customer: CUSTOMERS[4],
      status: 'ready',
      paymentStatus: 'cash',
      channel: 'walk-in',
      orderType: 'collection',
      items: [
        { name: 'Paneer tikka', qty: 1, price: 9 },
        { name: 'Veg samosa (2)', qty: 1, price: 3.2 },
      ],
      minutesAgo: 25,
      notes: '[demo-seed] Ready for collection',
    },
    {
      customer: CUSTOMERS[6],
      status: 'delivery',
      paymentStatus: 'card',
      channel: 'phone',
      orderType: 'delivery',
      items: [
        { name: 'Chicken biryani', qty: 3, price: 9.5 },
        { name: 'Butter chicken', qty: 1, price: 11 },
        { name: 'Pilau rice', qty: 2, price: 2.8 },
        { name: 'Gulab jamun', qty: 4, price: 3.5 },
      ],
      minutesAgo: 40,
      notes: '[demo-seed] Out for delivery',
      deliveryAddress: CUSTOMERS[6].address,
    },
    {
      customer: CUSTOMERS[7],
      status: 'completed',
      paymentStatus: 'card',
      channel: 'phone',
      orderType: 'collection',
      items: [
        { name: 'Lamb curry', qty: 1, price: 10.5 },
        { name: 'Garlic naan', qty: 1, price: 2.5 },
      ],
      minutesAgo: 120,
      notes: '[demo-seed] Completed earlier today',
    },
    {
      customer: CUSTOMERS[3],
      status: 'new',
      paymentStatus: 'unpaid',
      channel: 'kiosk',
      orderType: 'collection',
      items: [
        { name: 'Onion bhaji', qty: 2, price: 3.5 },
        { name: 'Mango lassi', qty: 2, price: 3 },
      ],
      minutesAgo: 1,
      notes: '[demo-seed] Fresh kiosk ticket',
    },
    {
      customer: CUSTOMERS[5],
      status: 'preparing',
      paymentStatus: 'card',
      channel: 'phone',
      orderType: 'collection',
      items: [
        { name: 'Chicken biryani', qty: 1, price: 9.5 },
        { name: 'Onion bhaji', qty: 1, price: 3.5 },
      ],
      minutesAgo: 12,
      notes: '[demo-seed] Halal — no cross-contam notes',
    },
    {
      customer: CUSTOMERS[8],
      status: 'new',
      paymentStatus: 'unpaid',
      channel: 'phone',
      orderType: 'delivery',
      items: [
        { name: 'Onion bhaji', qty: 4, price: 3.5 },
        { name: 'Veg samosa (2)', qty: 3, price: 3.2 },
        { name: 'Chicken biryani', qty: 2, price: 9.5 },
        { name: 'Butter chicken', qty: 2, price: 11 },
        { name: 'Lamb curry', qty: 2, price: 10.5 },
        { name: 'Paneer tikka', qty: 1, price: 9 },
        { name: 'Pilau rice', qty: 4, price: 2.8 },
        { name: 'Garlic naan', qty: 6, price: 2.5 },
        { name: 'Chips', qty: 3, price: 2.5 },
        { name: 'Mango lassi', qty: 4, price: 3 },
        { name: 'Coke', qty: 6, price: 1.8 },
        { name: 'Gulab jamun', qty: 8, price: 3.5 },
        { name: 'Chicken biryani', qty: 1, price: 9.5, dealName: 'extra tray' },
        { name: 'Butter chicken', qty: 1, price: 11 },
        { name: 'Pilau rice', qty: 2, price: 2.8 },
      ],
      minutesAgo: 3,
      notes: '[demo-seed] Huge party — ~15 lines for delivery board QA',
      deliveryAddress: CUSTOMERS[8].address,
    },
    {
      customer: CUSTOMERS[8],
      status: 'coming',
      paymentStatus: 'card',
      channel: 'phone',
      orderType: 'delivery',
      items: [
        { name: 'Chicken biryani', qty: 1, price: 9.5, dealName: 'Mile a Meal', dealIndex: 1, role: 'main' },
        { name: 'Pilau rice', qty: 1, price: 2.8, dealName: 'Mile a Meal', dealIndex: 1, role: 'side' },
        { name: 'Coke', qty: 1, price: 1.8, dealName: 'Mile a Meal', dealIndex: 1, role: 'drink' },
        { name: 'Butter chicken', qty: 1, price: 11, dealName: 'Mile a Meal', dealIndex: 2, role: 'main' },
        { name: 'Chips', qty: 1, price: 2.5, dealName: 'Mile a Meal', dealIndex: 2, role: 'side' },
        { name: 'Mango lassi', qty: 1, price: 3, dealName: 'Mile a Meal', dealIndex: 2, role: 'drink' },
        { name: 'Lamb curry', qty: 1, price: 10.5, dealName: 'Mile a Meal', dealIndex: 3, role: 'main' },
        { name: 'Garlic naan', qty: 1, price: 2.5, dealName: 'Mile a Meal', dealIndex: 3, role: 'side' },
        { name: 'Coke', qty: 1, price: 1.8, dealName: 'Mile a Meal', dealIndex: 3, role: 'drink' },
      ],
      minutesAgo: 5,
      notes: '[demo-seed] 3× Mile a Meal expanded to 9 kitchen lines',
      deliveryAddress: CUSTOMERS[8].address,
      specialName: 'Mile a Meal',
    },
  ];

  const rows = templates.map((t) => {
    const total = t.items.reduce((sum, i) => sum + i.qty * i.price, 0);
    const created = new Date(now - t.minutesAgo * 60_000).toISOString();
    const id = randomUUID();
    const orderNumber = n++;
    let notes = t.notes;
    if (t.specialName) {
      notes = `${notes} [[s2d:special=${encodeURIComponent(t.specialName)}|eta=40]]`;
    } else if (t.orderType === 'delivery') {
      notes = `${notes} [[s2d:eta=40]]`;
    }
    return {
      id,
      org_id: orgId,
      customer_id: t.customer.id,
      customer_name: t.customer.name,
      customer_phone: t.customer.phone,
      channel: t.channel,
      order_type: t.orderType,
      status: t.status,
      payment_status: t.paymentStatus,
      payment_method: t.paymentStatus === 'unpaid' ? null : t.paymentStatus === 'cash' ? 'cash' : 'card',
      order_number: orderNumber,
      items: t.items,
      total,
      delivery_address: t.deliveryAddress ?? null,
      notes,
      created_at: created,
      updated_at: created,
    };
  });

  const { error } = await supabase.from('orders').insert(rows);
  if (error) throw new Error(`orders: ${error.message}`);
  console.log(`[populate] Orders created: ${rows.length} (numbers ${rows[0].order_number}–${rows[rows.length - 1].order_number})`);
}

async function seedHugePartyOrdersIfMissing(supabase: ReturnType<typeof admin>, orgId: string) {
  const { data: existing } = await supabase
    .from('orders')
    .select('id')
    .eq('org_id', orgId)
    .ilike('notes', '%Huge party%')
    .limit(1);
  if (existing?.length) {
    console.log('[populate] Huge party orders already present — skipping');
    return;
  }
  const customer = CUSTOMERS[8];
  let n = await nextOrderNumber(supabase, orgId);
  const now = Date.now();
  const hugeItems = [
    { name: 'Onion bhaji', qty: 4, price: 3.5 },
    { name: 'Veg samosa (2)', qty: 3, price: 3.2 },
    { name: 'Chicken biryani', qty: 2, price: 9.5 },
    { name: 'Butter chicken', qty: 2, price: 11 },
    { name: 'Lamb curry', qty: 2, price: 10.5 },
    { name: 'Paneer tikka', qty: 1, price: 9 },
    { name: 'Pilau rice', qty: 4, price: 2.8 },
    { name: 'Garlic naan', qty: 6, price: 2.5 },
    { name: 'Chips', qty: 3, price: 2.5 },
    { name: 'Mango lassi', qty: 4, price: 3 },
    { name: 'Coke', qty: 6, price: 1.8 },
    { name: 'Gulab jamun', qty: 8, price: 3.5 },
    { name: 'Chicken biryani', qty: 1, price: 9.5 },
    { name: 'Butter chicken', qty: 1, price: 11 },
    { name: 'Pilau rice', qty: 2, price: 2.8 },
  ];
  const dealItems = [
    { name: 'Chicken biryani', qty: 1, price: 9.5, dealName: 'Mile a Meal', dealIndex: 1, role: 'main' },
    { name: 'Pilau rice', qty: 1, price: 2.8, dealName: 'Mile a Meal', dealIndex: 1, role: 'side' },
    { name: 'Coke', qty: 1, price: 1.8, dealName: 'Mile a Meal', dealIndex: 1, role: 'drink' },
    { name: 'Butter chicken', qty: 1, price: 11, dealName: 'Mile a Meal', dealIndex: 2, role: 'main' },
    { name: 'Chips', qty: 1, price: 2.5, dealName: 'Mile a Meal', dealIndex: 2, role: 'side' },
    { name: 'Mango lassi', qty: 1, price: 3, dealName: 'Mile a Meal', dealIndex: 2, role: 'drink' },
    { name: 'Lamb curry', qty: 1, price: 10.5, dealName: 'Mile a Meal', dealIndex: 3, role: 'main' },
    { name: 'Garlic naan', qty: 1, price: 2.5, dealName: 'Mile a Meal', dealIndex: 3, role: 'side' },
    { name: 'Coke', qty: 1, price: 1.8, dealName: 'Mile a Meal', dealIndex: 3, role: 'drink' },
  ];
  const rows = [
    {
      id: randomUUID(),
      org_id: orgId,
      customer_id: customer.id,
      customer_name: customer.name,
      customer_phone: customer.phone,
      channel: 'phone',
      order_type: 'delivery',
      status: 'new',
      payment_status: 'unpaid',
      payment_method: null,
      order_number: n++,
      items: hugeItems,
      total: hugeItems.reduce((s, i) => s + i.qty * i.price, 0),
      delivery_address: customer.address,
      notes: '[demo-seed] Huge party — ~15 lines for delivery board QA [[s2d:eta=40]]',
      created_at: new Date(now - 3 * 60_000).toISOString(),
      updated_at: new Date(now - 3 * 60_000).toISOString(),
    },
    {
      id: randomUUID(),
      org_id: orgId,
      customer_id: customer.id,
      customer_name: customer.name,
      customer_phone: customer.phone,
      channel: 'phone',
      order_type: 'delivery',
      status: 'coming',
      payment_status: 'card',
      payment_method: 'card',
      order_number: n++,
      items: dealItems,
      total: 12.5 * 3,
      delivery_address: customer.address,
      notes: `[demo-seed] 3× Mile a Meal expanded to 9 kitchen lines [[s2d:special=${encodeURIComponent('Mile a Meal')}|eta=40]]`,
      created_at: new Date(now - 5 * 60_000).toISOString(),
      updated_at: new Date(now - 5 * 60_000).toISOString(),
    },
  ];
  const { error } = await supabase.from('orders').insert(rows);
  if (error) throw new Error(`huge orders: ${error.message}`);
  console.log(`[populate] Huge party orders created: ${rows.length}`);
}

async function seedTablesAndReservations(supabase: ReturnType<typeof admin>, orgId: string) {
  const tables = [
    { label: 'Table 1', seats: 2, zone: 'Window', sort_order: 1 },
    { label: 'Table 2', seats: 4, zone: 'Main', sort_order: 2 },
    { label: 'Table 3', seats: 4, zone: 'Main', sort_order: 3 },
    { label: 'Table 4', seats: 6, zone: 'Booth', sort_order: 4 },
    { label: 'Table 5', seats: 8, zone: 'Party', sort_order: 5 },
  ];
  const now = new Date();
  const tableRows = tables.map((t) => ({
    id: randomUUID(),
    org_id: orgId,
    label: t.label,
    seats: t.seats,
    zone: t.zone,
    active: true,
    sort_order: t.sort_order,
    updated_at: now.toISOString(),
    created_at: now.toISOString(),
  }));
  const { error: tableErr } = await supabase.from('dining_tables').upsert(tableRows, { onConflict: 'id' });
  if (tableErr) console.warn('[populate] dining_tables skipped:', tableErr.message);
  else console.log(`[populate] Dining tables: ${tableRows.length}`);

  const starts = new Date(now.getTime() + 2 * 60 * 60_000);
  const reservations = [
    {
      id: randomUUID(),
      org_id: orgId,
      table_id: tableRows[1]?.id ?? null,
      party_size: 4,
      customer_name: 'Amelia Hart',
      customer_phone: '07700900101',
      customer_id: 'C-DEMO-001',
      starts_at: starts.toISOString(),
      ends_at: new Date(starts.getTime() + 90 * 60_000).toISOString(),
      status: 'confirmed',
      channel: 'phone',
      notes: '[demo-seed] Friday table',
      call_ids: [],
      created_at: now.toISOString(),
      updated_at: now.toISOString(),
    },
    {
      id: randomUUID(),
      org_id: orgId,
      table_id: tableRows[0]?.id ?? null,
      party_size: 2,
      customer_name: 'Ben Okonkwo',
      customer_phone: '07700900102',
      customer_id: 'C-DEMO-002',
      starts_at: new Date(starts.getTime() + 3 * 60 * 60_000).toISOString(),
      ends_at: new Date(starts.getTime() + 4.5 * 60 * 60_000).toISOString(),
      status: 'confirmed',
      channel: 'phone',
      notes: '[demo-seed] Date night',
      call_ids: [],
      created_at: now.toISOString(),
      updated_at: now.toISOString(),
    },
  ];
  const { error: resErr } = await supabase.from('reservations').insert(reservations);
  if (resErr) console.warn('[populate] reservations skipped:', resErr.message);
  else console.log(`[populate] Reservations: ${reservations.length}`);
}

async function main() {
  const supabase = admin();
  const orgId = await resolveOrgId(supabase);
  await upsertMenu(supabase, orgId);
  await upsertCustomers(supabase, orgId);
  await seedStaff(supabase, orgId);
  await seedOrders(supabase, orgId);
  await seedTablesAndReservations(supabase, orgId);

  console.log('\n=== Demo restaurant populated ===');
  console.log(`Org: ${orgId}`);
  console.log(`Password (all demo users): ${SEED_PASSWORD}`);
  console.log('Core staff: maya@ / leo@ / priya@ / kai@ / nina@ demo.sync2dine.io');
  console.log('Extra staff:');
  for (const s of EXTRA_STAFF) {
    console.log(`  ${s.role.padEnd(8)} ${s.email}`);
  }
  console.log(`Kiosk (no login): https://app.sync2dine.io/front?org=${orgId}`);
  console.log('Open https://app.sync2dine.io/login as maya@demo.sync2dine.io');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
