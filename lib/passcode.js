import { createHash, timingSafeEqual } from "node:crypto";

const digest = (value) => createHash("sha256").update(String(value)).digest();

// Optional shared passcode so strangers who find the URL can't spend your Claude credits.
// Set CLERAK_PASSCODE in Vercel; leave it unset to disable the check.
export function checkPasscode(req, res) {
  const expected = process.env.CLERAK_PASSCODE;
  if (!expected) return true;
  const given = req.headers["x-clerak-passcode"] ?? "";
  if (timingSafeEqual(digest(given), digest(expected))) return true;
  res.status(401).json({ error: "Wrong passcode. Open settings (gear icon) and enter your Clerak passcode." });
  return false;
}
