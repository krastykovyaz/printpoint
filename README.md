# Print Point

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

## Telegram

Each order arrives with three buttons. **Printing** and **Delivery** email the customer straight away. **Order ready** asks you for a photo of the pickup spot (within 30 minutes) and embeds it in the email; send `/skip` to notify without a photo. Once the customer is told, the bot deletes the order's messages from the chat (the CV and receipt) and blanks the customer's email, phone and location. `/stats` reports visits against orders.

Only the chat in `TELEGRAM_CHAT_ID` can use the bot, and the webhook only accepts calls carrying `TELEGRAM_WEBHOOK_SECRET`.

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
