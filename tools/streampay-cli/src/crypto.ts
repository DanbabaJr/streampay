import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from "node:crypto";

export interface EncryptedSecret {
  version: 1;
  kdf: "scrypt";
  cipher: "aes-256-gcm";
  salt: string;
  iv: string;
  tag: string;
  ciphertext: string;
}

export function encryptSecret(secret: string, password: string): EncryptedSecret {
  if (!secret || !password) throw new Error("secret and password must not be empty");
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = scryptSync(password, salt, 32);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(secret, "utf8"),
    cipher.final(),
  ]);
  return {
    version: 1,
    kdf: "scrypt",
    cipher: "aes-256-gcm",
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

export function decryptSecret(value: unknown, password: string): string {
  if (!password) throw new Error("password must not be empty");
  if (!value || typeof value !== "object") throw new Error("invalid encrypted key file");
  const file = value as Partial<EncryptedSecret>;
  if (
    file.version !== 1 ||
    file.kdf !== "scrypt" ||
    file.cipher !== "aes-256-gcm" ||
    !file.salt ||
    !file.iv ||
    !file.tag ||
    !file.ciphertext
  ) {
    throw new Error("unsupported or invalid encrypted key file");
  }
  const salt = Buffer.from(file.salt, "base64");
  const iv = Buffer.from(file.iv, "base64");
  const key = scryptSync(password, salt, 32);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(Buffer.from(file.tag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(file.ciphertext, "base64")),
    decipher.final(),
  ]).toString("utf8");
}