import { useEffect, useState } from "react";
import type { Update } from "@tauri-apps/plugin-updater";
import { currentVersion, findUpdate, installUpdate, updatesSupported } from "@/lib/app-update";

const RECHECK_MS = 6 * 60 * 60 * 1000;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function InstallButton({ update }: { update: Update }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const start = async () => {
    setBusy(true);
    setError("");
    try {
      await installUpdate(update);
    } catch (e) {
      setError("Update nahi ho saki. Internet check kar ke dobara try karein. (" + errorText(e) + ")");
      setBusy(false);
    }
  };
  return (
    <>
      <button
        disabled={busy}
        className="rounded bg-amber-500 px-4 py-2 font-bold text-slate-900 disabled:opacity-50"
        onClick={() => void start()}
      >
        {busy ? "Update ho rahi hai, app band na karein..." : "Abhi update karein"}
      </button>
      {error && <p className="mt-2 w-full text-sm text-red-600">{error}</p>}
    </>
  );
}

/** Appears on its own when a newer release exists. Being offline stays silent. */
export function UpdateBanner() {
  const [update, setUpdate] = useState<Update | null>(null);
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    if (!updatesSupported()) return;
    const look = () => {
      findUpdate()
        .then((found) => {
          if (found) setUpdate(found);
        })
        .catch((e: unknown) => console.warn("Update check failed:", errorText(e)));
    };
    look();
    const timer = setInterval(look, RECHECK_MS);
    return () => clearInterval(timer);
  }, []);

  if (!update || hidden) return null;
  return (
    <div
      role="status"
      className="fixed bottom-4 right-4 z-50 w-80 rounded-xl border bg-white p-4 text-slate-900 shadow-xl"
    >
      <p className="mb-3 text-sm">
        <b>Nayi update available hai (v{update.version}).</b> Aap ka data mehfooz rahega.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <InstallButton update={update} />
        <button className="rounded border px-3 py-2 text-sm" onClick={() => setHidden(true)}>
          Baad mein
        </button>
      </div>
    </div>
  );
}

/** Settings card: shows the installed version and allows a manual check. */
export function UpdatePanel() {
  const [version, setVersion] = useState("");
  const [status, setStatus] = useState("");
  const [update, setUpdate] = useState<Update | null>(null);
  const supported = updatesSupported();

  useEffect(() => {
    if (supported) void currentVersion().then(setVersion);
  }, [supported]);

  if (!supported) return null;
  const look = async () => {
    setStatus("Check ho raha hai...");
    try {
      const found = await findUpdate();
      setUpdate(found);
      setStatus(found ? `Nayi version v${found.version} available hai.` : "App up to date hai.");
    } catch (e) {
      setStatus("Check nahi ho saka. Internet check karein. (" + errorText(e) + ")");
    }
  };
  return (
    <section className="app-card rounded-xl border bg-white p-5">
      <h2 className="mb-4 font-bold">App update</h2>
      <p className="mb-3 text-sm">Installed version: {version}</p>
      <div className="flex flex-wrap items-center gap-2">
        <button className="rounded border px-4 py-2" onClick={() => void look()}>
          Check for update
        </button>
        {update && <InstallButton update={update} />}
      </div>
      <p className="mt-2 text-sm text-slate-600">{status}</p>
    </section>
  );
}
