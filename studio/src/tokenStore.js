import fs from 'node:fs';
import path from 'node:path';

/**
 * Where the board keeps its device token: encrypted by the operating system
 * (Electron's safeStorage — DPAPI on Windows, so only this Windows account on
 * this machine can read it back), in a file of its own beside the settings.
 *
 * It never reaches the dock's web page: the main process makes every API
 * call, and the page only ever sees what those calls return. If the OS has
 * no encryption to offer, the token is not saved at all — a board that has
 * to be re-paired after a restart is better than a key in plain text.
 *
 * `safeStorage` is passed in so this can be tested without Electron.
 */
export function createTokenStore({ file, safeStorage }) {
  return {
    available: () => safeStorage.isEncryptionAvailable(),

    save(token) {
      if (!safeStorage.isEncryptionAvailable()) {
        throw new Error('This computer cannot encrypt the board’s key, so it will not be stored');
      }
      const sealed = safeStorage.encryptString(token).toString('base64');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      // Written aside and renamed, so a power cut mid-write leaves the old key, not half of one.
      const temp = `${file}.tmp`;
      fs.writeFileSync(temp, JSON.stringify({ v: 1, sealed }), { mode: 0o600 });
      fs.renameSync(temp, file);
    },

    /** The token, or null if there is none or it cannot be opened (another account, a copied file). */
    load() {
      try {
        const { sealed } = JSON.parse(fs.readFileSync(file, 'utf8'));
        return sealed ? safeStorage.decryptString(Buffer.from(sealed, 'base64')) : null;
      } catch {
        return null;
      }
    },

    clear() {
      fs.rmSync(file, { force: true });
    },
  };
}
