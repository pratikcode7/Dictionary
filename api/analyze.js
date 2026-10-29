import Anthropic from "@anthropic-ai/sdk";
import { getVercelOidcToken } from "@vercel/oidc";
import { checkPasscode } from "../lib/passcode.js";
import { buildPlan, isIsoDate } from "../lib/plan.js";

const GATEWAY_URL = "https://ai-gateway.vercel.sh";

// Uses an Anthropic key when one is set. Otherwise calls Claude through Vercel AI Gateway,
// which signs in with the deployment's own OIDC token, so no key has to be created or pasted.
async function aiClient() {
  if (process.env.ANTHROPIC_API_KEY) return { client: new Anthropic(), gateway: false };
  const token = process.env.AI_GATEWAY_API_KEY || (await getVercelOidcToken());
  return { client: new Anthropic({ apiKey: token, baseURL: GATEWAY_URL }), gateway: true };
}

const MAX_IMAGES = 8;
const DATA_URL = /^data:(image\/(?:jpeg|png|webp|gif));base64,([A-Za-z0-9+/=]+)$/;

const SYSTEM = `You are Clerak, a court clerk assistant for an Indian advocate practising in Pune district courts.

You receive:
1. Screenshots of the eCourts Services app screen "Todays Case List" (My Cases > Calendar). Each case card shows the NEXT date (month, day, year in the left column, e.g. "Nov 07 2026"), a case number such as "Reg.Sum.Suit/93/2023", "R.C.S./1066/2025", "Cri.Bail Appln./1316/2026", "Spl.Case/646/2026" or "Sessions Case/115/2018", the court/judge, the party names, and a stage badge such as "Evidence", "Charge", "W.S. and Say", "Unready Board" or "Order on Exh".
   The screenshots come from scrolling one list, so consecutive screenshots overlap. List each case only once.
2. The advocate's Google Calendar events on the board date. Event titles are usually party names written informally (e.g. "Sudam Gaikwad", "Potana V/s Vikram Pillie", "Meena Christraj Swamy Alias Meena Swamy Iseli. (D)"). The location usually has the judge's surname and a short case number (e.g. "Taklikar Court S.C.No.428/17", "K.M Jaisingani Reg. Sum Suit No.93/23", "S.M Takalikar Court A Bail No.1316/26", "D.U Dongare Court RCS No.1066/25").

Your job:
- Extract every case visible in the screenshots into "cases", giving each a short ref ("C1", "C2", ...). Write next_date as YYYY-MM-DD, or "" if no date is readable. Copy case numbers and names as printed.
- For every calendar event, add one entry to "matches". Set case_ref to the matching case's ref, or "" if none matches.
- Match on case number first: the same number and year with any abbreviation counts ("S.C.No.428/17" = "Sessions Case/428/2017", "A Bail No.1316/26" = "Cri.Bail Appln./1316/2026", "Spl.C.No.646/26" = "Spl.Case/646/2026", "RCS No.1066/25" = "R.C.S./1066/2025", "Reg. Sum Suit No.93/23" = "Reg.Sum.Suit/93/2023"). Then use party names and the judge's name to confirm or to match when no number is given.
- confidence: "high" when the case number matches, "medium" when only names clearly match, "low" when unsure. Never guess a match to fill gaps; a wrong hearing date harms the client. Use "" and confidence "low" when nothing matches.
- list_date: the date in the "Todays Case List" header as YYYY-MM-DD, or "" if it is not visible.
- Keep each reason short (under 15 words).`;

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["list_date", "cases", "matches"],
  properties: {
    list_date: { type: "string" },
    cases: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["ref", "case_number", "parties", "court", "next_date", "stage"],
        properties: {
          ref: { type: "string" },
          case_number: { type: "string" },
          parties: { type: "string" },
          court: { type: "string" },
          next_date: { type: "string" },
          stage: { type: "string" },
        },
      },
    },
    matches: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["event_id", "case_ref", "confidence", "reason"],
        properties: {
          event_id: { type: "string" },
          case_ref: { type: "string" },
          confidence: { type: "string", enum: ["high", "medium", "low"] },
          reason: { type: "string" },
        },
      },
    },
  },
};

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST." });
  if (!checkPasscode(req, res)) return;

  const { images, events, boardDate } = req.body ?? {};
  if (!Array.isArray(images) || images.length === 0) {
    return res.status(400).json({ error: "Add at least one eCourts screenshot." });
  }
  if (images.length > MAX_IMAGES) {
    return res.status(400).json({ error: `Use at most ${MAX_IMAGES} screenshots.` });
  }
  if (!Array.isArray(events) || events.length === 0) {
    return res.status(400).json({ error: "No calendar events to update on this date." });
  }
  if (!isIsoDate(boardDate)) return res.status(400).json({ error: "Invalid board date." });

  const content = [];
  for (const [i, dataUrl] of images.entries()) {
    const m = DATA_URL.exec(String(dataUrl));
    if (!m) return res.status(400).json({ error: `Screenshot ${i + 1} is not a valid image.` });
    content.push({ type: "text", text: `Screenshot ${i + 1}:` });
    content.push({ type: "image", source: { type: "base64", media_type: m[1], data: m[2] } });
  }
  const calendar = events.map((e) => ({
    event_id: String(e.id),
    title: String(e.title ?? ""),
    location: String(e.location ?? ""),
    notes: String(e.notes ?? "").slice(0, 300),
  }));
  content.push({
    type: "text",
    text: `Board date: ${boardDate}\n\nGoogle Calendar events on the board date:\n${JSON.stringify(calendar, null, 1)}`,
  });

  let ai;
  try {
    ai = await aiClient();
  } catch {
    return res.status(500).json({
      error: "No AI access: deploy on Vercel (uses AI Gateway automatically) or set ANTHROPIC_API_KEY.",
    });
  }

  const request = {
    max_tokens: 16000,
    output_config: { effort: "high", format: { type: "json_schema", schema: SCHEMA } },
    system: SYSTEM,
    messages: [{ role: "user", content }],
  };

  try {
    const response = ai.gateway
      ? await ai.client.messages.create({ model: "anthropic/claude-opus-5.5", ...request })
      : await ai.client.beta.messages.create({
          model: "claude-opus-5-5",
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
          ...request,
        });

    if (response.stop_reason === "refusal") {
      return res.status(422).json({ error: "The AI declined to read these screenshots. Try clearer screenshots." });
    }
    if (response.stop_reason === "max_tokens") {
      return res.status(422).json({ error: "Too many cases in one go. Send fewer screenshots at a time." });
    }
    const text = response.content.find((b) => b.type === "text")?.text;
    if (!text) return res.status(502).json({ error: "The AI returned no answer. Try again." });

    const extraction = JSON.parse(text);
    const plan = buildPlan({ eventIds: calendar.map((e) => e.event_id), extraction, boardDate });
    return res.status(200).json(plan);
  } catch (err) {
    if (err instanceof Anthropic.APIError && /customer_verification_required/.test(JSON.stringify(err.error ?? ""))) {
      return res.status(402).json({
        error: "Vercel AI Gateway needs a payment method on your Vercel account to unlock its free monthly credit. Vercel → AI Gateway → add a card.",
      });
    }
    if (err instanceof Anthropic.APIError && /insufficient_funds|quota_for_entity_exceeded/.test(JSON.stringify(err.error ?? ""))) {
      return res.status(402).json({ error: "Vercel AI Gateway credit is used up. Add credit in Vercel → AI Gateway." });
    }
    if (err instanceof Anthropic.AuthenticationError) {
      return res.status(500).json({
        error: ai.gateway
          ? "Vercel AI Gateway sign-in failed. Check Vercel → Settings → Security → OIDC Federation is on."
          : "ANTHROPIC_API_KEY on the server is invalid.",
      });
    }
    if (err instanceof Anthropic.RateLimitError) {
      return res.status(429).json({ error: "AI is busy (rate limited). Wait a minute and try again." });
    }
    if (err instanceof Anthropic.APIError) {
      return res.status(502).json({ error: `AI error: ${err.message}` });
    }
    if (err instanceof SyntaxError) {
      return res.status(502).json({ error: "The AI answer could not be read. Try again." });
    }
    throw err;
  }
}
