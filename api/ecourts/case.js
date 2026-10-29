import { checkPasscode } from "../../lib/passcode.js";
import { CNR_PATTERN, searchByCnr } from "../../lib/ecourts.js";

// Looks up one case by CNR using the captcha the advocate typed.
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST." });
  if (!checkPasscode(req, res)) return;

  const { session, cnr, code } = req.body ?? {};
  const cleanCnr = String(cnr ?? "").toUpperCase().replace(/[\s-]/g, "");
  if (!CNR_PATTERN.test(cleanCnr) || cleanCnr.length !== 16) {
    return res.status(400).json({ error: "CNR must be 16 characters, like MHPU010012342023." });
  }
  if (!session || !String(code ?? "").trim()) {
    return res.status(400).json({ error: "Type the captcha first." });
  }

  try {
    res.status(200).json(await searchByCnr({ session, cnr: cleanCnr, code: String(code).trim() }));
  } catch (err) {
    res.status(502).json({ error: err.message || "Could not reach eCourts." });
  }
}
