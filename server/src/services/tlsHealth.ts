import crypto from "node:crypto";
import fs from "node:fs";
import type { Config } from "../config";

export interface TlsHealth {
  enabled: boolean;
  cert: string | null;
  key: string | null;
  certExists: boolean;
  keyExists: boolean;
  certReadable: boolean;
  keyReadable: boolean;
  validFrom: string | null;
  validTo: string | null;
  daysRemaining: number | null;
  subject: string | null;
  issuer: string | null;
  fingerprint256: string | null;
  errors: string[];
}

export function getTlsHealth(cfg: Config): TlsHealth {
  const health: TlsHealth = {
    enabled: cfg.https.enabled,
    cert: cfg.https.cert,
    key: cfg.https.key,
    certExists: false,
    keyExists: false,
    certReadable: false,
    keyReadable: false,
    validFrom: null,
    validTo: null,
    daysRemaining: null,
    subject: null,
    issuer: null,
    fingerprint256: null,
    errors: [],
  };

  if (!cfg.https.enabled) return health;
  if (!cfg.https.cert) health.errors.push("https.cert is not configured");
  if (!cfg.https.key) health.errors.push("https.key is not configured");

  if (cfg.https.cert) {
    health.certExists = fs.existsSync(cfg.https.cert);
    try {
      const certPem = fs.readFileSync(cfg.https.cert, "utf8");
      health.certReadable = true;
      const cert = new crypto.X509Certificate(certPem);
      health.validFrom = cert.validFrom;
      health.validTo = cert.validTo;
      health.subject = cert.subject;
      health.issuer = cert.issuer;
      health.fingerprint256 = cert.fingerprint256;
      health.daysRemaining = Math.floor((Date.parse(cert.validTo) - Date.now()) / 86_400_000);
      if (health.daysRemaining < 0) health.errors.push("certificate is expired");
      else if (health.daysRemaining <= 14) health.errors.push("certificate expires soon");
    } catch (err) {
      health.errors.push(`certificate read/parse failed: ${(err as Error).message}`);
    }
  }

  if (cfg.https.key) {
    health.keyExists = fs.existsSync(cfg.https.key);
    try {
      fs.accessSync(cfg.https.key, fs.constants.R_OK);
      health.keyReadable = true;
    } catch (err) {
      health.errors.push(`key is not readable: ${(err as Error).message}`);
    }
  }

  return health;
}
