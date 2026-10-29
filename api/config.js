// Public, non-secret settings the browser needs before it can talk to Google.
export default function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.status(200).json({
    googleClientId: process.env.GOOGLE_CLIENT_ID ?? "",
    passcodeRequired: Boolean(process.env.CLERAK_PASSCODE),
    aiReady: Boolean(process.env.ANTHROPIC_API_KEY),
  });
}
