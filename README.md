# Print CV

Resume print-order page. A customer attaches a resume, picks copies and pages (black and white only for now), pays through a Revolut link, attaches the receipt and submits. The shop gets the order by email and Telegram and updates the customer from Telegram buttons.

## Setup

1. Install Node.js 20 or newer.
2. Run `npm install`.
3. Copy `.env.example` to `.env` and fill it in.
4. Run `npm start` and open `http://127.0.0.1:3030`.

In production the app listens on `127.0.0.1` only and sits behind nginx, which terminates HTTPS.

## How an order flows

- The server validates the upload (extension and file signature), the email, and the sizes, then computes the price itself: copies × pages, with the discount applying only to pages past the tenth. Rates live in `RATES_CENTS` in `server.js` and are mirrored in `public/app.js` for the on-page calculator.
- The files go to the shop's Telegram chat; the server deletes its own copy as soon as the shop has been told, and the shop email is only a notice without the CV or contact details. If Telegram is off or fails, the email carries the files instead.
- The order is accepted once the shop has been told through at least one channel (email or Telegram). If neither works, the order is rolled back and the customer is asked to retry.
- An order without a payment receipt is still accepted but flagged `[NO PAYMENT YET]`.

## CV handoff from tsech.online

A page on `HANDOFF_ORIGIN` (default `https://tsech.online`) can open this site in a new window and send its finished PDF straight into the order form. The browser does it, so nothing reaches the server until the customer submits an order. The page accepts only messages from that origin and only from the window that opened it, and only a real PDF up to 10 MB. The sending side is a few lines on tsech.online; see `docs/tsech-handoff.md`.

## Telegram

Each order arrives with three buttons. **Printing** and **Delivery** email the customer straight away. **Order ready** asks you for a photo of the pickup spot (within 30 minutes) and embeds it in the email; send `/skip` to notify without a photo. Once the customer is told, the bot deletes the order's messages from the chat (the CV and receipt) and blanks the customer's email, phone and location. `/stats` reports visits against orders.

Only the chat in `TELEGRAM_CHAT_ID` can use the bot, and the webhook only accepts calls carrying `TELEGRAM_WEBHOOK_SECRET`.

## Online payment with Grandlivre (optional)

Off by default: the page and orders work as before (a Revolut link and a receipt) until both `GRANDLIVRE_KEY` and `GRANDLIVRE_WEBHOOK_SECRET` are set in `.env`. When they are:

1. **Pressing the button** ("Continue to payment") creates the order. The server computes the price from copies × pages (the browser's amount is ignored), stores the CV, and asks Grandlivre for one payment link for this order (`ref` = the order code, e.g. `QP-3AE140`). The page then opens the Grandlivre widget for that link. If Grandlivre cannot be reached (5 s timeout, one retry), the order is taken the old way, flagged `NOT PAID YET`, and the customer is told to pay by Revolut and quote the order code.
2. **"I paid" in the widget** is only the customer's word. The page shows "confirming", nothing is sent to the shop, and nothing prints.
3. **The signed webhook** `POST /grandlivre/webhook` moves the order: `payment.reported` tells the shop (Telegram + email, with the CV) that a payment is waiting for you to confirm; `payment.confirmed` (you marked the money received in Grandlivre) marks it **paid**, emails the customer and, with a print agent, queues the print job; `payment.declined` marks a problem and emails the customer. An order never leaves *paid*. A payment whose amount, currency or link does not match the order is flagged to you in Telegram and never marks it paid.
4. **A missed webhook** is caught by asking Grandlivre (`GET /api/v1/notices?ref=`): when the customer reloads the page, when a reported payment is still unconfirmed after 5 minutes (checked every 2 minutes), and from the **💶 Check payment** button on the order's Telegram message.
5. **Unpaid orders** are deleted after `GRANDLIVRE_HOLD_HOURS` (default 24): the CV and contact details go, and the payment link is closed. The customer can also press "Start a new order" to drop one.

Configuration (server `.env` only; the key and secret never reach the browser):

```
GRANDLIVRE_URL=https://app.portemonnaie.space
GRANDLIVRE_KEY=glk_...                 # Grandlivre: Profile › Money › API keys (limit the accounts and the largest sum)
GRANDLIVRE_WEBHOOK_SECRET=whsec_...    # shown once when you set the webhook address on that key
```

Set the key's webhook address to `https://print.unilu.space/grandlivre/webhook`. The page's security policy then also allows `script-src` and `frame-src` for the Grandlivre address, and nothing broader.

Deliveries are verified (`X-Grandlivre-Signature: t=…,v1=hex`, HMAC-SHA256 of `"<t>.<raw body>"`, at most 5 minutes old) and logged without secrets (`grandlivre_events` table: delivery, event, order, result). A retried delivery (same delivery id) is ignored; any other repeat is harmless because states only move forward.

**Manual end-to-end check** (needs a real key; use a small real sum to your own account):

1. Place an order for 5 copies × 1 page → €2.50; a link is created with `ref` = the order code (see the log line or Grandlivre › Payment links).
2. Pay through the widget and attach a proof → the page says "confirming"; Telegram shows `💶 Payment reported`, the order is `payment_reported`.
3. In Grandlivre press "Money received" (Profile › Money › Payments) → within about 20 s the webhook arrives, the order becomes `paid`, the customer gets the confirmation email and the job is queued.
4. Send the webhook test message from the key's card (`payment.test`): answered 200, nothing changes. A request with a wrong signature gets 401.

## Receipt check

When a customer attaches a payment receipt, the server reads the amount on it and compares it with the order, then adds one line to the Telegram message (and the email notice): `✅ shows €2.00, matches the order`, `⚠️ shows €1.00 but the order is €2.00`, or `❓ couldn't confirm the amount ... look at the image`. The check is local (Tesseract OCR, Pillow and poppler, installed with `apt install tesseract-ocr tesseract-ocr-eng poppler-utils python3-pil`), so receipts never leave the server. It takes about a second and never blocks an order: if the tools are missing or reading fails, the message says the receipt was not checked.

The reading is advisory. A match needs at least two OCR passes to agree on the largest amount on the receipt, so the check can say "couldn't confirm" but should not call a wrong amount right. A screenshot can still be edited, so look at the image when the amount matters.

## Printing from Telegram (optional)

With `PRINT_AGENT_TOKEN` set, each order in Telegram gets a **Print on printer** button. Nothing prints until you tap it. The CV then waits on the server (deleted once printed, or after `PRINT_HOLD_HOURS`, default 48) for the print agent to collect it.

The agent in `agent/print-agent.js` runs on the computer next to the printer (a Raspberry Pi or laptop with CUPS) and makes outgoing HTTPS calls only, so it works on any Wi-Fi without port forwarding:

1. Add the printer in CUPS and note its queue name (`lpstat -p`).
2. Install Node 20, copy `agent/print-agent.js` there, and set `PRINT_SERVER`, `PRINT_AGENT_TOKEN` (same value as the server) and `PRINTER`.
3. Run `node print-agent.js`, or use `agent/printpoint-agent.service` to start it at boot.

PDFs print directly; Word files are converted with LibreOffice (`soffice`) first. Options go to `lp` through `LP_OPTIONS` (default `-o print-color-mode=monochrome`). If printing fails, the bot says why and the button works again.

## Data and privacy

- Orders are in `data/orders.db`; uploaded files are in `uploads/`. Both are ignored by Git.
- Uploads are deleted from the server right after delivery to the shop, so `uploads/` normally stays empty. With the print button enabled, the CV stays until it is printed.
- Marking an order ready erases its Telegram messages and blanks its contact details. Telegram only lets bots delete messages for about 48 hours, so mark orders ready promptly; if a deletion fails the bot says so.
- As a backstop, after `RETENTION_DAYS` (default 30) any order still holding contact details is blanked. The order row stays so counts remain correct.
- `scripts/backup_db.sh` takes a consistent copy of the database; in production a systemd timer runs it nightly.

## Limits

- 8 order attempts per IP per 15 minutes and 200 per day overall (`ORDER_RATE_LIMIT`, `ORDER_DAILY_LIMIT`).
- One counted visit per IP per 30 minutes.
- Files up to 10 MB; phone up to 40 characters; location up to 300.

## Tests

`npm test` runs against temporary directories with a fake mail transport. It never reads `.env` or touches the real database.
