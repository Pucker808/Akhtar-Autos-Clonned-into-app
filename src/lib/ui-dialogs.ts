/**
 * Desktop-safe dialogs and print helpers for Akhtar Autos Desktop.
 * Prefer in-app / Tauri dialogs over browser prompt/confirm/window.open.
 * Falls back to browser APIs when not running inside Tauri.
 */
import { ask as tauriAsk, confirm as tauriConfirm, message as tauriMessage } from "@tauri-apps/plugin-dialog";

function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** Modal text prompt. Returns null when the user cancels. */
export async function askText(message: string, defaultValue = ""): Promise<string | null> {
  if (isTauri()) {
    try {
      // Tauri dialog plugin has no free-text prompt; use an in-WebView modal.
      return await inAppPrompt(message, defaultValue);
    } catch {
      return inAppPrompt(message, defaultValue);
    }
  }
  if (typeof window !== "undefined" && typeof window.prompt === "function") {
    return window.prompt(message, defaultValue);
  }
  return inAppPrompt(message, defaultValue);
}

/** Confirm dialog. */
export async function askConfirm(message: string, title = "Akhtar Autos"): Promise<boolean> {
  if (isTauri()) {
    try {
      const result = await tauriConfirm(message, { title, kind: "warning" });
      return Boolean(result);
    } catch {
      /* fall through */
    }
  }
  if (typeof window !== "undefined" && typeof window.confirm === "function") {
    return window.confirm(message);
  }
  return inAppConfirm(message);
}

/** Simple message (optional). */
export async function showMessage(message: string, title = "Akhtar Autos"): Promise<void> {
  if (isTauri()) {
    try {
      await tauriMessage(message, { title, kind: "info" });
      return;
    } catch {
      /* fall through */
    }
  }
  if (typeof window !== "undefined" && typeof window.alert === "function") {
    window.alert(message);
    return;
  }
  await inAppConfirm(message);
}

/**
 * Print HTML without window.open pop-ups (works in Tauri WebView).
 * Uses a hidden iframe + print().
 */
export function printHtml(html: string): void {
  if (typeof document === "undefined") {
    throw new Error("Print is only available in the UI");
  }
  const iframe = document.createElement("iframe");
  iframe.setAttribute("title", "Akhtar Autos receipt");
  iframe.style.position = "fixed";
  iframe.style.right = "0";
  iframe.style.bottom = "0";
  iframe.style.width = "0";
  iframe.style.height = "0";
  iframe.style.border = "0";
  document.body.appendChild(iframe);
  const doc = iframe.contentDocument ?? iframe.contentWindow?.document;
  if (!doc) {
    document.body.removeChild(iframe);
    throw new Error("Could not create print frame");
  }
  doc.open();
  doc.write(html);
  doc.close();
  const win = iframe.contentWindow;
  const cleanup = () => {
    try {
      document.body.removeChild(iframe);
    } catch {
      /* already removed */
    }
  };
  setTimeout(() => {
    try {
      win?.focus();
      win?.print();
    } finally {
      setTimeout(cleanup, 1000);
    }
  }, 250);
}

function inAppPrompt(message: string, defaultValue: string): Promise<string | null> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.style.cssText =
      "position:fixed;inset:0;background:rgba(15,23,42,.55);z-index:99999;display:flex;align-items:center;justify-content:center;padding:16px;";
    const panel = document.createElement("div");
    panel.style.cssText =
      "background:#fff;color:#0f172a;max-width:420px;width:100%;border-radius:12px;padding:20px;box-shadow:0 20px 50px rgba(0,0,0,.25);font-family:system-ui,sans-serif;";
    panel.innerHTML = `<p style="margin:0 0 12px;font-size:14px;line-height:1.4;white-space:pre-wrap;"></p>
      <input type="text" style="width:100%;box-sizing:border-box;border:1px solid #cbd5e1;border-radius:8px;padding:10px 12px;font-size:14px;margin-bottom:16px;" />
      <div style="display:flex;gap:8px;justify-content:flex-end;">
        <button type="button" data-act="cancel" style="border:1px solid #cbd5e1;background:#fff;border-radius:8px;padding:8px 14px;cursor:pointer;">Cancel</button>
        <button type="button" data-act="ok" style="border:0;background:#f59e0b;color:#0f172a;font-weight:700;border-radius:8px;padding:8px 14px;cursor:pointer;">OK</button>
      </div>`;
    const p = panel.querySelector("p")!;
    p.textContent = message;
    const input = panel.querySelector("input") as HTMLInputElement;
    input.value = defaultValue;
    const finish = (value: string | null) => {
      overlay.remove();
      resolve(value);
    };
    panel.querySelector('[data-act="cancel"]')!.addEventListener("click", () => finish(null));
    panel.querySelector('[data-act="ok"]')!.addEventListener("click", () => finish(input.value));
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") finish(input.value);
      if (e.key === "Escape") finish(null);
    });
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) finish(null);
    });
    overlay.appendChild(panel);
    document.body.appendChild(overlay);
    setTimeout(() => input.focus(), 0);
  });
}

function inAppConfirm(message: string): Promise<boolean> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.style.cssText =
      "position:fixed;inset:0;background:rgba(15,23,42,.55);z-index:99999;display:flex;align-items:center;justify-content:center;padding:16px;";
    const panel = document.createElement("div");
    panel.style.cssText =
      "background:#fff;color:#0f172a;max-width:420px;width:100%;border-radius:12px;padding:20px;box-shadow:0 20px 50px rgba(0,0,0,.25);font-family:system-ui,sans-serif;";
    panel.innerHTML = `<p style="margin:0 0 16px;font-size:14px;line-height:1.4;white-space:pre-wrap;"></p>
      <div style="display:flex;gap:8px;justify-content:flex-end;">
        <button type="button" data-act="cancel" style="border:1px solid #cbd5e1;background:#fff;border-radius:8px;padding:8px 14px;cursor:pointer;">Cancel</button>
        <button type="button" data-act="ok" style="border:0;background:#f59e0b;color:#0f172a;font-weight:700;border-radius:8px;padding:8px 14px;cursor:pointer;">Continue</button>
      </div>`;
    panel.querySelector("p")!.textContent = message;
    const finish = (v: boolean) => {
      overlay.remove();
      resolve(v);
    };
    panel.querySelector('[data-act="cancel"]')!.addEventListener("click", () => finish(false));
    panel.querySelector('[data-act="ok"]')!.addEventListener("click", () => finish(true));
    overlay.appendChild(panel);
    document.body.appendChild(overlay);
  });
}

// silence unused import when tree-shaken differently
void tauriAsk;
