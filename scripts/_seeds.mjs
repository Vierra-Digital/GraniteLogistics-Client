// Seeded app states shared by shots.mjs and contrast.mjs.
//
// Each one is written into localStorage before app.html boots, so a screen that needs a
// signed-in customer or an operator gets one without touching a real account.
// A signed-in customer with a few orders in varied states, so lists are not empty and the
// status pills are all exercised.
export const customerSeed = (verified = true) => ({
  auth: { token: "shot-token", user: { email: "jane@example.com", name: "Jane Doe", role: "Customer", emailVerified: verified } },
  state: {
    settings: { role: "Customer", roleChosen: true },
    packages: [
      pkg(1, "OutforDelivery", "UPS", "LG 55\" OLED TV", 1299),
      pkg(2, "InTransit", "FedEx", "Herman Miller Aeron chair", 890),
      pkg(3, "Delivered", "UPS", "Sonos Arc soundbar", 799),
    ],
    manifests: [], loadUnits: [], events: [],
  },
});

export const opsSeed = () => ({
  auth: { token: "shot-token", user: { email: "ops@example.com", name: "Ken Filbert", role: "Admin", emailVerified: true } },
  state: {
    settings: { role: "Admin", roleChosen: true, cloud: { url: "", key: "granite-dev-key", autoSync: false } },
    packages: [
      pkg(1, "OutforDelivery", "UPS", "LG 55\" OLED TV", 1299),
      pkg(2, "InTransit", "FedEx", "Herman Miller Aeron chair", 890),
      pkg(3, "Delivered", "UPS", "Sonos Arc soundbar", 799),
      pkg(4, "Staged", "UPS", "Dyson V15 vacuum", 649),
      pkg(5, "PickedUp", null, "Weber Genesis grill", 1099),
      pkg(6, "Won", null, "Samsung 980 Pro 2TB SSD", 199),
    ],
    manifests: [], loadUnits: [], events: [],
  },
});

// A freshly-registered customer and a freshly-provisioned workspace, so the empty states
// get looked at too -- they are the first thing a real new user sees.
export const emptyCustomerSeed = () => ({
  auth: { token: "shot-token", user: { email: "new@example.com", name: "Sam Reed", role: "Customer", emailVerified: true } },
  state: { settings: { role: "Customer", roleChosen: true }, packages: [], manifests: [], loadUnits: [], events: [] },
});

export const emptyOpsSeed = () => ({
  auth: { token: "shot-token", user: { email: "ops@example.com", name: "Ken Filbert", role: "Admin", emailVerified: true } },
  state: {
    settings: { role: "Admin", roleChosen: true, cloud: { url: "", key: "granite-dev-key", autoSync: false } },
    packages: [], manifests: [], loadUnits: [], events: [],
  },
});

// applyTheme() reads state.settings.theme, so flipping it in the seed is all it takes.
export const dark = (s) => ({ ...s, state: { ...s.state, settings: { ...s.state.settings, theme: "dark" } } });

export function pkg(n, status, carrier, description, value) {
  const now = Date.now();
  const cities = [["Dayton", "OH", "45402"], ["Columbus", "OH", "43004"], ["Cincinnati", "OH", "45202"]];
  const c = cities[n % cities.length];
  const names = ["Jane Doe", "Marcus Webb", "Priya Raman", "Tom Ellery", "Sara Nolan", "Devin Cross"];
  return {
    id: "GL-10" + (40 + n), status, source: n <= 3 ? "Customer Order" : "API",
    orderRef: "#" + (10000 + n * 137), barcode: "GL10" + (40 + n),
    carrier, lane: carrier ? "Lane 2" : null, batchId: carrier ? "BATCH-70" + n : null,
    tracking: carrier === "UPS" ? "1Z999AA1012345678" + n : carrier === "FedEx" ? "7712 3456 789" + n : null,
    item: { description, value, weight: 12 + n * 4 }, photos: {},
    customer: { name: names[n - 1] || "Jane Doe", address: (100 + n * 7) + " Birchwood Lane",
      city: c[0], state: c[1], zip: c[2], phone: "937-555-01" + (10 + n) },
    history: [{ stage: "Won", ts: now - 86400000 * 3, note: "Order received." }],
    promisedTs: now + 86400000 * 2, exception: null,
    customerEmail: n <= 3 ? "jane@example.com" : null,
  };
}


// Worst-case realistic content. Every seed above uses tidy 20-character strings, so the
// layouts have only ever been measured against data that fits comfortably. Real logistics
// data does not look like that: manufacturer part names run long, so do hyphenated
// surnames and municipality names, declared values reach seven figures, and an
// unrecognised carrier or a long exception reason has to land somewhere.
//
// Nothing here is padding for its own sake -- these lengths are the kind a real
// integration produces.
const LONG_ITEM = "Samsung 85\" QN900D Neo QLED 8K Smart TV with One Connect Box, Wall Mount Kit and 5-Year Protection Plan";
const LONG_NAME = "Wilhelmina Fitzgerald-Montgomery III";
const LONG_CITY = "Charlotte Amalie West-Fredriksted";
const LONG_ADDR = "18845 Northwest Commonwealth Industrial Parkway, Building 7, Suite 1200, Loading Dock C";

export const stressSeed = () => {
  const now = Date.now();
  const mk = (n, status, carrier, over) => ({
    ...pkg(n, status, carrier, LONG_ITEM, 1249999),
    customer: { name: LONG_NAME, address: LONG_ADDR, city: LONG_CITY, state: "VI", zip: "00802-1147",
      phone: "+1 (340) 555-0142 ext. 88213" },
    ...over,
  });
  return {
    auth: { token: "shot-token", user: { email: "operations.coordinator@granite-logistics-partners.example.com",
      name: "Wilhelmina Fitzgerald-Montgomery III", role: "Admin", emailVerified: true } },
    state: {
      settings: { role: "Admin", roleChosen: true, cloud: { url: "", key: "granite-dev-key", autoSync: false } },
      packages: [
        mk(1, "OutforDelivery", "UPS"),
        mk(2, "InTransit", "FedEx", { exception: { type: "Refused at door, recipient disputes the declared contents", ts: now } }),
        mk(3, "Delivered", "UPS"),
        mk(4, "Staged", "UPS"),
        mk(5, "PickedUp", null),
        mk(6, "Won", null),
      ],
      manifests: [], loadUnits: [], events: [],
    },
  };
};

export const stressCustomerSeed = () => {
  const s = stressSeed();
  return {
    auth: { token: "shot-token", user: { email: "wilhelmina.fitzgerald-montgomery@example.com",
      name: "Wilhelmina Fitzgerald-Montgomery III", role: "Customer", emailVerified: true } },
    state: { ...s.state, settings: { role: "Customer", roleChosen: true },
      packages: s.state.packages.slice(0, 3).map((p) => ({ ...p, customerEmail: "wilhelmina.fitzgerald-montgomery@example.com" })) },
  };
};
