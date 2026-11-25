import { describe, it, expect, beforeEach } from "vitest";
import {
  getPersistenceMode,
  setPersistenceMode,
  isSqliteMode,
  setConfiguredSqlitePath,
  getConfiguredSqlitePath,
} from "../lib/persistence";
import { toPaisa, fromPaisa, formatPKR, pctOf } from "../lib/money";

describe("persistence mode", () => {
  beforeEach(() => {
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
    localStorage.clear();
    setPersistenceMode("dexie");
    setConfiguredSqlitePath(null);
  });

  it("defaults to dexie outside forced session", () => {
    expect(getPersistenceMode()).toBe("dexie");
    expect(isSqliteMode()).toBe(false);
  });

  it("never reports sqlite outside the Tauri runtime, even when forced", () => {
    setPersistenceMode("sqlite");
    expect(getPersistenceMode()).toBe("dexie");
    expect(isSqliteMode()).toBe(false);
  });

  it("can select sqlite mode only inside Tauri", () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", { value: {}, configurable: true });
    setPersistenceMode("sqlite");
    expect(getPersistenceMode()).toBe("sqlite");
    expect(isSqliteMode()).toBe(true);
    setPersistenceMode("dexie");
    expect(isSqliteMode()).toBe(false);
  });

  it("stores configured sqlite path", () => {
    setConfiguredSqlitePath("C:\\\\Data\\\\akhtar-autos.db");
    expect(getConfiguredSqlitePath()).toContain("akhtar-autos.db");
    setConfiguredSqlitePath(null);
    expect(getConfiguredSqlitePath()).toBeNull();
  });
});

describe("monetary precision (paisa)", () => {
  it("stores integer paisa without float drift", () => {
    expect(toPaisa("10.50")).toBe(1050);
    expect(toPaisa(10.5)).toBe(1050);
    expect(toPaisa("0.01")).toBe(1);
    expect(fromPaisa(1050)).toBe("10.50");
    expect(formatPKR(1050)).toContain("10.50");
  });

  it("rounds percentage of paisa amounts", () => {
    expect(pctOf(10000, 17)).toBe(1700);
  });
});
