import { checkPasscode } from "../../lib/passcode.js";
import { startSession } from "../../lib/ecourts.js";

// Opens a fresh eCourts session and returns its captcha image for the advocate to read.
export default async function handler(req, res) {
  if (!checkPasscode(req, res)) return;
  res.setHeader("Cache-Control", "no-store");
  try {
    res.status(200).json(await startSession());
  } catch (err) {
    res.status(502).json({ error: err.message || "Could not reach eCourts." });
  }
}
