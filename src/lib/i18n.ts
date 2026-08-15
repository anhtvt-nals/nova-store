export type SiteLocale = 'en' | 'id';

// Edit customer-facing EN/ID copy here. Admin-facing copy intentionally remains English.
export const translations = {
  en: {
    howItWorks: 'How it works', plans: 'Plans', forOperators: 'For operators', signIn: 'Sign in', customerLogin: 'Customer login',
    heroBadge: 'US network · hourly rotation', heroTitle: 'Routes you can', heroAccent: 'reason about.', heroBody: 'Rent dependable US SOCKS5 nodes for the work that needs a clean signal. One dashboard, automatic IP rotation, no infrastructure theatre.',
    seeHow: 'See how it works', noLockIn: 'No long-term lock-in', rotateEvery: 'Rotate every 60 min', controlPlane: 'the control plane',
    controlTitle: 'Small surface area. Serious signal.', controlBody: 'Nodenesia keeps the operational model visible: pick a plan, get a node, watch the clock. The network takes care of the rest.',
    selectTitle: 'Choose your footprint', selectBody: 'Start in the US with a node count and duration that fits your run. More countries can slot into the same model.',
    connectTitle: 'Copy one clean endpoint', connectBody: 'Credentials arrive in a focused connection view, ready for scripts, browsers, crawlers, and growth tooling.',
    rotateTitle: 'Let the hour turn over', rotateBody: 'IP rotation happens automatically, so your team stays focused on the request instead of the maintenance.',
    plansTitle: 'Start narrow. Scale cleanly.', plansBody: 'Every plan is built around predictable node access, not a maze of add-ons.',
    trialPlanName: 'Trial', trialPlanPrice: '50 credits', trialPlanDescription: 'A one-time trial for new accounts to test a clean SOCKS5 route.', trialPlanNodes: '1 node', trialPlanDuration: '1 day', trialPlanRotation: 'Automatic IP rotation', trialPlanAccess: 'One-time new-account access',
    proPlanName: 'Pro', proPlanPrice: 'Pay as you go', proPlanDescription: 'Flexible credit billing for teams that need more proxy capacity.', proPlanNodes: '5, 10, 15, or 20 nodes', proPlanDuration: '3, 7, 14, or 30 days', proPlanRotation: 'Automatic IP rotation', proPlanAccess: 'Credit-based checkout', goToClient: 'Open client workspace',
    serviceWorkspace: 'service workspace', chooseService: 'Choose a service', serviceIntro: 'Each service has its own focused workspace for ordering and management.', available: 'available', comingSoon: 'coming soon', open: 'Open',
    services: 'Services', security: 'Security', signOut: 'Sign out', admin: 'Admin',
    proxyTitle: 'US SOCKS5 Proxy', proxyIntro: 'Order nodes by country, manage credentials, and track live time in one focused workspace.', orderProxy: 'Order proxy',
    activeNodes: 'Active nodes', requestsToday: 'Requests today', successRate: 'Success rate', proxyOrders: 'Proxy orders', liveStatus: 'Synced by live status stream', proxyTraffic: 'Proxy traffic', last24Hours: 'Last 24 hours', accountHistory: 'Account history',
    myNodes: 'My proxy nodes', myNodesBody: 'Every order can contain multiple nodes, all using the same account username and password.', forceRecreate: 'Force recreate all', recreating: 'Recreating…',
    catalog: 'proxy catalog', socksByCountry: 'SOCKS5 by country', catalogBody: 'Compare countries and create an order directly from the table.', country: 'Country', proxyService: 'Proxy service', priceNode: 'Credit / node', nodes: 'Nodes', days: 'Days', payment: 'Payment', total: 'Total', action: 'Action', perDay: '/ day', orderNow: 'Order now', creating: 'Creating…',
    recentOrders: 'Recent orders', ordersBody: 'Track pending approvals, active subscriptions, and past purchases.',
  },
  id: {
    howItWorks: 'Cara kerja', plans: 'Paket', forOperators: 'Untuk operator', signIn: 'Masuk', customerLogin: 'Login pelanggan',
    heroBadge: 'Jaringan AS · rotasi per jam', heroTitle: 'Rute yang dapat', heroAccent: 'Anda andalkan.', heroBody: 'Sewa node SOCKS5 AS yang andal untuk pekerjaan yang membutuhkan koneksi bersih. Satu dashboard, rotasi IP otomatis, tanpa kerumitan infrastruktur.',
    seeHow: 'Lihat cara kerjanya', noLockIn: 'Tanpa kontrak jangka panjang', rotateEvery: 'Rotasi setiap 60 menit', controlPlane: 'pusat kendali',
    controlTitle: 'Sederhana di permukaan. Andal di jaringan.', controlBody: 'Nodenesia membuat operasional tetap jelas: pilih paket, dapatkan node, pantau waktunya. Jaringan menangani sisanya.',
    selectTitle: 'Pilih cakupan Anda', selectBody: 'Mulai dari AS dengan jumlah node dan durasi yang sesuai. Negara lain dapat ditambahkan dengan model yang sama.',
    connectTitle: 'Salin satu endpoint yang rapi', connectBody: 'Kredensial tersedia dalam tampilan koneksi yang terfokus, siap untuk skrip, browser, crawler, dan tooling pertumbuhan.',
    rotateTitle: 'Biarkan rotasi berjalan', rotateBody: 'Rotasi IP berlangsung otomatis agar tim Anda fokus pada permintaan, bukan pemeliharaan.',
    plansTitle: 'Mulai kecil. Skalakan dengan rapi.', plansBody: 'Setiap paket dibangun untuk akses node yang dapat diprediksi, tanpa add-on yang membingungkan.',
    trialPlanName: 'Trial', trialPlanPrice: '50 kredit', trialPlanDescription: 'Trial satu kali untuk akun baru yang ingin mencoba rute SOCKS5 bersih.', trialPlanNodes: '1 node', trialPlanDuration: '1 hari', trialPlanRotation: 'Rotasi IP otomatis', trialPlanAccess: 'Akses satu kali untuk akun baru',
    proPlanName: 'Pro', proPlanPrice: 'Bayar sesuai pemakaian', proPlanDescription: 'Pembayaran kredit fleksibel untuk tim yang membutuhkan kapasitas proxy lebih besar.', proPlanNodes: '5, 10, 15, atau 20 node', proPlanDuration: '3, 7, 14, atau 30 hari', proPlanRotation: 'Rotasi IP otomatis', proPlanAccess: 'Checkout berbasis kredit', goToClient: 'Buka workspace client',
    serviceWorkspace: 'ruang kerja layanan', chooseService: 'Pilih layanan', serviceIntro: 'Setiap layanan memiliki ruang kerja khusus untuk pemesanan dan pengelolaan.', available: 'tersedia', comingSoon: 'segera hadir', open: 'Buka',
    services: 'Layanan', security: 'Keamanan', signOut: 'Keluar', admin: 'Admin',
    proxyTitle: 'Proxy SOCKS5 AS', proxyIntro: 'Pesan node berdasarkan negara, kelola kredensial, dan pantau status langsung dalam satu ruang kerja.', orderProxy: 'Pesan proxy',
    activeNodes: 'Node aktif', requestsToday: 'Permintaan hari ini', successRate: 'Tingkat sukses', proxyOrders: 'Pesanan proxy', liveStatus: 'Tersinkron dari status langsung', proxyTraffic: 'Lalu lintas proxy', last24Hours: '24 jam terakhir', accountHistory: 'Riwayat akun',
    myNodes: 'Node proxy saya', myNodesBody: 'Setiap pesanan dapat berisi beberapa node, semuanya menggunakan username dan password akun yang sama.', forceRecreate: 'Buat ulang semua', recreating: 'Membuat ulang…',
    catalog: 'katalog proxy', socksByCountry: 'SOCKS5 berdasarkan negara', catalogBody: 'Bandingkan negara dan buat pesanan langsung dari tabel.', country: 'Negara', proxyService: 'Layanan proxy', priceNode: 'Kredit / node', nodes: 'Node', days: 'Hari', payment: 'Pembayaran', total: 'Total', action: 'Aksi', perDay: '/ hari', orderNow: 'Pesan sekarang', creating: 'Membuat…',
    recentOrders: 'Pesanan terbaru', ordersBody: 'Pantau persetujuan tertunda, langganan aktif, dan pembelian sebelumnya.',
  },
} as const;

export type TranslationKey = keyof typeof translations.en;
