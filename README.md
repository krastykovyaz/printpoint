# QuickPrint resume orders

One-page resume print order form. It accepts a PDF or Word document, stores the order in SQLite, and emails the print file to your chosen inbox through Gmail.

## Setup

1. Install Node.js 20 or newer.
2. Run `npm install`.
3. Copy `.env.example` to `.env` and enter your Gmail address, a Gmail **App Password**, and the email address that should receive print orders.
4. Run `npm start` and open `http://localhost:3030`.

### Gmail App Password

Turn on 2-Step Verification for the Gmail account, then create an App Password in your Google Account security settings. Put that 16-character password in `GMAIL_APP_PASSWORD`. The app sends from `GMAIL_USER` to `PRINT_SHOP_EMAIL`, so these may be different addresses.

## What is saved

Orders are stored in `data/orders.db`. Uploaded documents are retained in `uploads/` so the order record continues to point to the file. Both folders are ignored by Git.

# printpoint
