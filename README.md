# CLERAK — AI court clerk for advocates

Every day an advocate opens the **eCourts Services** app, reads the next date of each case heard today, then opens **Google Calendar** and moves each hearing by hand. Clerak does that for you from your iPhone.

**Live app:** <https://dictionary-two-theta.vercel.app> (Google Cloud project `clerak`, OAuth client "Clerak web")

**One tap:** tap the glowing **CLERAK** core, pick your eCourts *Todays Case List* screenshots, review the list, then tap **ENGAGE**. Every hearing moves to its next date.

---

## How it works

```
 eCourts app            Clerak (website on your iPhone)                  Google Calendar
 ───────────            ────────────────────────────────                 ───────────────
 "Todays Case List"  →  1. reads today's events from your calendar   →   29 Oct: 13 hearings
 screenshots            2. Claude AI reads the screenshots and
                           matches each event by case number
                           (S.C.No.428/17 = Sessions Case/428/2017)
                           and party names
                        3. shows you:  Sudam Gaikwad  29 OCT → 26 NOV
                        4. ENGAGE  → moves each event            →   26 Nov: Sudam Gaikwad ✓
```

* **Only the date changes.** Title, location, notes and colour stay as they are.
* **Nothing moves without your tap.** Low-confidence matches start unticked. You can edit any new date before you engage.
* **Not updated yet?** If eCourts still shows today's date (or no date), the event stays put and is marked *NOT UPDATED ON eCOURTS*.
* **Undo:** Settings → *Undo last update* puts every moved hearing back.
* **LIVE eCOURTS** (second mode): checks one case directly on the eCourts website by CNR number. eCourts asks for a captcha on every search, so you type it in Clerak. The first time you enter a CNR for an event, Clerak saves it in that event's notes so you don't have to type it again.

---

## One-time setup (about 20 minutes)

You need three things: an **Anthropic API key** (the AI), a **Google OAuth Client ID** (calendar access) and a free **Vercel** account (hosting).

### 1. Anthropic API key
1. Go to <https://console.anthropic.com> → *API Keys* → **Create Key**.
2. Add a little credit under *Billing*. A daily run with 3–4 screenshots costs a few rupees.

### 2. Deploy to Vercel
1. Sign in at <https://vercel.com> with GitHub.
2. **Add New → Project** → import `pratikcode7/Dictionary` → **Deploy**.
3. Note your URL, e.g. `https://dictionary-xyz.vercel.app`.

### 3. Google Client ID
1. Open <https://console.cloud.google.com> → create a project named **Clerak**.
2. *APIs & Services → Library* → search **Google Calendar API** → **Enable**.
3. *APIs & Services → OAuth consent screen* → **External** → app name *Clerak*, your email → Save.
   Under **Test users**, add your own Gmail (the one with your court calendar).
4. *APIs & Services → Credentials → Create credentials → OAuth client ID*
   * Application type: **Web application**
   * Authorised JavaScript origins: `https://YOUR-APP.vercel.app`
   * Authorised redirect URIs: `https://YOUR-APP.vercel.app/`  ← keep the trailing slash
   Tip: open Clerak → **SETUP**. It shows both addresses with COPY buttons.
5. Copy the **Client ID** (ends with `.apps.googleusercontent.com`) and paste it into Clerak → **SETUP → Google Client ID**.
   That's all Google needs; you can skip the `GOOGLE_CLIENT_ID` variable below.

### 4. Add the keys to Vercel
Vercel → your project → *Settings → Environment Variables*:

| Name | Value |
|---|---|
| `ANTHROPIC_API_KEY` | your key from step 1 |
| `GOOGLE_CLIENT_ID` | optional: the Client ID from step 3 (or paste it in Clerak's SETUP instead) |
| `CLERAK_PASSCODE` | any secret word. This stops strangers who find your link from using your AI credit. |

Then *Deployments → ⋯ → Redeploy*.

### 5. Put Clerak on your iPhone home screen
Open your Vercel URL in **Safari** → Share → **Add to Home Screen**. It opens full-screen like an app.
The first time, open ⚙ **Settings** and enter your passcode, then tap the core to link Google.

---

## Daily use

1. In **eCourts Services** → *My Cases → Calendar* → *Todays Case List*, take screenshots while scrolling until every case is covered (overlapping screenshots are fine, up to 8).
2. Open **Clerak** → tap the core → pick the screenshots.
3. Check the brief and tap **ENGAGE**.

Google sign-in lasts one hour. After that, Clerak asks you to tap once to reconnect.

### Talk to Clerak 🎙
Tap the **mic** in the centre of the bottom bar and speak. Clerak answers out loud (turn voice off in Setup).

| Say | Clerak does |
|---|---|
| "update the dates" / "tarikh badlo" | gets ready. Then tap the core to pick screenshots (iPhone only opens the photo picker on a tap) |
| "update tomorrow's dates" | switches the board date to tomorrow first |
| "review" / "read the list" | opens the list and reads out the new dates |
| "engage" / "yes" / "do it" | moves the selected hearings |
| "status" / "how many" | tells you how many hearings, updated, pending |
| "undo" | puts the last moved hearings back |
| "set the date to yesterday" | changes the board date |
| "live check" | opens the live eCourts lookup |
| "help" / "stop" | lists commands / stops talking |

Voice input uses Safari's built-in speech recognition. If the mic does nothing on iPhone, turn on **Settings → General → Keyboard → Enable Dictation** and allow the microphone for the site. If it doesn't work from the home-screen icon, open Clerak in Safari.

---

## Project layout

```
public/            the website (index.html, styles.css, app.js, icons)
api/analyze.js     Claude reads screenshots + matches events (structured JSON)
api/config.js      tells the page which keys are configured
api/ecourts/       live eCourts lookup by CNR (captcha typed by you)
lib/               shared server code (+ tests in test/)
vercel.json        Mumbai region (bom1), so eCourts sees an Indian server
```

Run the tests with `npm test`.

## Limits worth knowing
* The eCourts **app** has no public API and a website cannot read another app's data. That is why Clerak uses screenshots.
* The eCourts **website** needs a captcha for every search. Clerak never solves it automatically; you type it.
* Your Google token stays in your phone's browser. Your screenshots go only to Claude, through your own Vercel server.
