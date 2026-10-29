import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
  timingSafeEqual,
  type DecipherGCM,
} from "node:crypto";
import { Transform } from "node:stream";
import { config } from "../../config.js";

/**
 * Chiffrement AES-256-GCM.
 *
 * Deux usages :
 *  - secrets courts (identifiants de connexion des bases surveillées), via
 *    encryptString / decryptString, scellés par la MASTER_KEY ;
 *  - fichiers de sauvegarde, via createEncryptStream / createDecryptStream.
 *
 * Format d'un secret scellé : base64( iv(12) | tag(16) | ciphertext ).
 * Format d'un fichier chiffré : [ iv(12) | tag(16) à la fin ]. Le tag GCM
 * étant connu seulement en fin de flux, on l'écrit à la fin et on le relit
 * au déchiffrement (voir createDecryptStream).
 */

const KEY = config.masterKey; // 32 octets garantis par config.ts
const IV_LEN = 12;
const TAG_LEN = 16;

export function encryptString(plaintext: string): string {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv("aes-256-gcm", KEY, iv);
  const enc = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString("base64");
}

export function decryptString(sealed: string): string {
  const buf = Buffer.from(sealed, "base64");
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const enc = buf.subarray(IV_LEN + TAG_LEN);
  const decipher = createDecipheriv("aes-256-gcm", KEY, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString(
    "utf8",
  );
}

/**
 * Flux de chiffrement d'un fichier de sauvegarde.
 * En-tête : iv(12). Pied : tag(16). Corps : ciphertext.
 */
export function createEncryptStream(): Transform {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv("aes-256-gcm", KEY, iv);
  let headerWritten = false;
  return new Transform({
    transform(chunk, _enc, cb) {
      if (!headerWritten) {
        this.push(iv);
        headerWritten = true;
      }
      cb(null, cipher.update(chunk));
    },
    flush(cb) {
      try {
        const last = cipher.final();
        if (last.length) this.push(last);
        this.push(cipher.getAuthTag()); // tag en pied de flux
        cb();
      } catch (err) {
        cb(err as Error);
      }
    },
  });
}

/**
 * Flux de déchiffrement correspondant.
 * On met en tampon la fin du flux pour isoler les 16 derniers octets (tag).
 */
export function createDecryptStream(): Transform {
  let iv: Buffer | null = null;
  let decipher: DecipherGCM | null = null;
  let tail = Buffer.alloc(0); // conserve au moins TAG_LEN octets en réserve

  return new Transform({
    transform(chunk: Buffer, _enc, cb) {
      let data = Buffer.concat([tail, chunk]);
      if (!iv) {
        if (data.length < IV_LEN) {
          tail = data;
          return cb();
        }
        iv = data.subarray(0, IV_LEN);
        decipher = createDecipheriv("aes-256-gcm", KEY, iv) as DecipherGCM;
        data = data.subarray(IV_LEN);
      }
      // Toujours garder TAG_LEN octets en réserve (ils peuvent être le tag).
      if (data.length > TAG_LEN) {
        const body = data.subarray(0, data.length - TAG_LEN);
        tail = data.subarray(data.length - TAG_LEN);
        cb(null, decipher!.update(body));
      } else {
        tail = data;
        cb();
      }
    },
    flush(cb) {
      try {
        if (!decipher || tail.length < TAG_LEN) {
          return cb(new Error("Flux chiffré tronqué ou invalide"));
        }
        const tag = tail.subarray(tail.length - TAG_LEN);
        const body = tail.subarray(0, tail.length - TAG_LEN);
        decipher.setAuthTag(tag);
        const out = Buffer.concat([
          body.length ? decipher.update(body) : Buffer.alloc(0),
          decipher.final(),
        ]);
        if (out.length) this.push(out);
        cb();
      } catch (err) {
        cb(err as Error);
      }
    },
  });
}

// --- Hachage de mot de passe (scrypt, sans dépendance native) --------------

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const derived = scryptSync(password, salt, 64);
  return `scrypt$${salt.toString("hex")}$${derived.toString("hex")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  const salt = Buffer.from(parts[1]!, "hex");
  const expected = Buffer.from(parts[2]!, "hex");
  const derived = scryptSync(password, salt, expected.length);
  return (
    derived.length === expected.length && timingSafeEqual(derived, expected)
  );
}
