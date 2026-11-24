import { db } from "./db";

export interface Settings {
  shopName: string; phone?: string; address?: string; receiptFooter?: string; returnPolicy?: string;
  taxEnabled: boolean; taxPct: number; allowNegativeStock: boolean; costing: "fifo";
  defaultLocationId?: number; currency: "PKR"; timezone: "Asia/Karachi";
  theme: "light" | "dark" | "system";
}

const defaults: Settings = {
  shopName: "Akhtar Autos", taxEnabled: false, taxPct: 0, allowNegativeStock: false, costing: "fifo",
  currency: "PKR", timezone: "Asia/Karachi", theme: "system",
};

export async function getSettings(): Promise<Settings> {
  const row = await db.meta.get("settings");
  return { ...defaults, ...((row?.value as object) ?? {}) };
}

export async function saveSettings(partial: Partial<Settings>) {
  const cur = await getSettings();
  await db.meta.put({ key: "settings", value: { ...cur, ...partial } });
}

let _deviceId: string | null = null;
export function deviceIdSync(): string {
  if (_deviceId) return _deviceId;
  try {
    const k = "akhtar-device-id";
    let id = localStorage.getItem(k);
    if (!id) { id = crypto.randomUUID(); localStorage.setItem(k, id); }
    _deviceId = id;
    return id;
  } catch {
    _deviceId = "unknown";
    return _deviceId;
  }
}
export async function getDeviceId() {
  return deviceIdSync();
}
