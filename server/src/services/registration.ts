import type { Config } from "../config";
import type { Db } from "../db/db";

export type RegistrationMode = "closed" | "invite" | "open";

export function getRegistrationMode(cfg: Config, db: Db): RegistrationMode {
  const stored = db.settings.get("registration.mode");
  if (stored === "closed" || stored === "invite" || stored === "open") return stored;

  const open = db.settings.getBool("registration.open", cfg.registration.open);
  const requireInvite = db.settings.getBool("registration.requireInvite", cfg.registration.requireInvite);
  return open && !requireInvite ? "open" : requireInvite ? "invite" : "closed";
}

export function setRegistrationMode(db: Db, mode: RegistrationMode) {
  db.settings.set("registration.mode", mode);
  db.settings.setBool("registration.open", mode === "open");
  db.settings.setBool("registration.requireInvite", mode === "invite");
}

export function registrationFlags(mode: RegistrationMode) {
  return {
    mode,
    open: mode === "open",
    requireInvite: mode === "invite",
  };
}
