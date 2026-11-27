import { useRef } from "react";
import { writeSafetyBackup } from "@/lib/backup";
import { importBackupFile } from "@/lib/localFolder";
import { askConfirm } from "@/lib/ui-dialogs";

/** Replaces all records with a backup file. The current records are saved first. */
export function RestoreBackupButton({ onRestored, onError }: { onRestored: () => void; onError: (message: string) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const restore = async (file: File) => {
    if (!(await askConfirm(`"${file.name}" se restore karne par is computer ka maujooda sara record badal jayega. Continue?`))) return;
    try {
      if ("__TAURI_INTERNALS__" in window) await writeSafetyBackup("pre-restore-backups", "before-restore");
      await importBackupFile(file);
      onRestored();
    } catch (e) {
      onError("Restore nahi hua, purana data waisa hi hai: " + (e instanceof Error ? e.message : String(e)));
    }
  };
  return (
    <>
      <button className="rounded border px-4 py-2" onClick={() => input.current?.click()}>Restore from file</button>
      <input
        ref={input} type="file" accept=".json,application/json" className="hidden" aria-label="Backup file"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file) void restore(file);
        }}
      />
    </>
  );
}
