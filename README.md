# Print Point

Resume print-order page. A customer attaches a resume, picks copies, pages and colour, pays through a Revolut link, attaches the receipt and submits. The shop gets the order by email and Telegram and updates the customer from Telegram buttons.

## Setup

1. Install Node.js 20 or newer.
2. Run `npm install`.
3. Copy `.env.example` to `.env` and fill it in.
4. Run `npm start` and open `http://127.0.0.1:3030`.

In production the app listens on `127.0.0.1` only and sits behind nginx, which terminates HTTPS.

## How an order flows

- The server validates the upload (extension and file signature), the email, and the sizes, then computes the price itself: copies × pages, with the discount applying only to pages past the tenth. Rates live in `RATES_CENTS` in `server.js` and are mirrored in `public/app.js` for the on-page calculator.
- The order is accepted once the shop has been told through at least one channel (email or Telegram). If neither works, the order is rolled back and the customer is asked to retry.
- An order without a payment receipt is still accepted but flagged `[NO PAYMENT YET]`.

## Telegram

Each order arrives with three buttons. **Printing** and **Delivery** email the customer straight away. **Order ready** asks you for a photo of the pickup spot (within 30 minutes) and embeds it in the email; send `/skip` to notify without a photo. `/stats` reports visits against orders.

Only the chat in `TELEGRAM_CHAT_ID` can use the bot, and the webhook only accepts calls carrying `TELEGRAM_WEBHOOK_SECRET`.

## Data and privacy

- Orders are in `data/orders.db`; uploaded files are in `uploads/`. Both are ignored by Git.
- After `RETENTION_DAYS` (default 30) an order's files are deleted and its email, phone, location and filename are blanked. The order row stays so counts remain correct.
- `scripts/backup_db.sh` takes a consistent copy of the database; in production a systemd timer runs it nightly.

## Limits

- 8 order attempts per IP per 15 minutes and 200 per day overall (`ORDER_RATE_LIMIT`, `ORDER_DAILY_LIMIT`).
- One counted visit per IP per 30 minutes.
- Files up to 10 MB; phone up to 40 characters; location up to 300.

## Tests

`npm test` runs against temporary directories with a fake mail transport. It never reads `.env` or touches the real database.
