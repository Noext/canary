/**
 * Copies text to the clipboard and reports whether it worked.
 *
 * The async Clipboard API only exists in a secure context: the dashboard is
 * reached over HTTPS or through a localhost tunnel, but a plain HTTP origin on
 * the LAN has no `navigator.clipboard` at all, and a refused copy can fail
 * silently. Both cases come back as `false` so the caller can say the copy did
 * not happen instead of showing a success the user cannot see.
 */
export async function copyText(text: string): Promise<boolean> {
  if (!text) {
    return false;
  }
  try {
    const write = navigator.clipboard?.writeText(text);
    if (!write) {
      return false;
    }
    await write;
    return true;
  } catch {
    return false;
  }
}
