/**
 * Saves a text file chosen by the user.
 *
 * The Android WebView ignores `<a download>` on blob URLs, so inside the Android
 * app the native "Save" screen and the Tauri fs plugin are used. Windows and
 * browsers keep the original download behaviour.
 */
import { save } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";

function isAndroidApp(): boolean {
  return "__TAURI_INTERNALS__" in window && /android/i.test(navigator.userAgent);
}

/** Returns false when the user cancels the Android save screen. Throws if writing fails. */
export async function saveTextFile(fileName: string, text: string): Promise<boolean> {
  if (isAndroidApp()) {
    const target = await save({ defaultPath: fileName });
    if (!target) return false;
    await writeTextFile(target, text);
    return true;
  }
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(url);
  return true;
}
