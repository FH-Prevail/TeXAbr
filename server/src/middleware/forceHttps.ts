import type { RequestHandler } from "express";
import type { Db } from "../db/db";

// HSTS + HTTP→HTTPS redirect, gated on auth.https.enforced. Only redirects
// when the request really arrived over plain HTTP — TLS-terminating proxies
// set X-Forwarded-Proto, so we trust that header when a proxy is in front
// (not enabled by default; admin must opt in via Express's trust proxy).

export function forceHttps(db: Db): RequestHandler {
  return (req, res, next) => {
    if (!db.registry.getBool("auth.https.enforced")) return next();

    const proto = (req.header("x-forwarded-proto") ?? "").toLowerCase()
      || ((req.socket as { encrypted?: boolean }).encrypted ? "https" : "http");

    if (proto !== "https") {
      const host = req.header("host");
      if (!host) return res.status(400).send("Host header required");
      const url = `https://${host}${req.originalUrl}`;
      return res.redirect(301, url);
    }

    const maxAge = db.registry.getInt("auth.https.hstsMaxAge");
    res.setHeader("Strict-Transport-Security", `max-age=${maxAge}; includeSubDomains`);
    next();
  };
}
