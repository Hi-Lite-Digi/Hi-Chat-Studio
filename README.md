# Hi-Lite WhatsApp Demo Studio

Paste any public online-store link and create a tailored WhatsApp-style sales demo. The app reads the store's public page and JSON-LD product data, prepares a catalogue, and opens an interactive customer chat. If a site blocks automated reading, the demo still starts with a clearly labelled sample catalogue that you can replace by pasting products.

## Live demo

Try the deployed app at **[hi-chat-studio.vercel.app](https://hi-chat-studio.vercel.app/)**.

## Run locally

Requirements: Node.js 22.13 or newer.

```bash
npm install
npm run dev
```

Open the local URL printed in the terminal. The default is `http://localhost:3000`; another port is used automatically when that port is busy.

For a quick walkthrough, choose **Or load a sample store** on the start screen.

## What is included

- Public store-page reader with redirects, response-size limits, timeouts, and private-network blocking
- Paginated catalogue indexing for Shopify and WooCommerce, plus JSON-LD and linked storefront/product-page discovery
- Graceful fallback catalogues for sites that are protected, client-rendered, or do not expose product data
- Editable copy/paste catalogue using `Name | Price | Description | Category`
- Interactive WhatsApp-style chat with product and budget matching
- A customer-safe team handoff for account actions, payments, refunds, and specialist requests
- Optional N8N webhook handoff, with a working local sales assistant when no webhook is configured

## Connect the n8n brain

Import [`n8n/hi-lite-multi-store-sales-brain.json`](n8n/hi-lite-multi-store-sales-brain.json) into n8n, select the OpenAI credential already used by your Sia Huat workflow, and activate it. Then copy `.env.example` to `.env.local` and add the production webhook URL:

```text
N8N_WEBHOOK_URL=https://your-n8n.example.com/webhook/hi-lite-sales-brain
N8N_REQUIRED=true
```

Restart `npm run dev` after changing the environment file. With `N8N_REQUIRED=true`, every normal sales reply must come from n8n; the app does not silently pretend the local fallback is the connected brain.

The app sends this JSON to N8N:

```json
{
  "sessionId": "demo-...",
  "customerMessage": "Anything under $80?",
  "business": {
    "name": "Store name",
    "summary": "Store description",
    "domain": "store.example",
    "products": [],
    "policies": []
  },
  "history": [],
  "instructions": "Act as the store's sales assistant and stay within the catalogue..."
}
```

The final N8N webhook node should return JSON with one of these string fields:

```json
{ "reply": "The message to show in WhatsApp." }
```

`message`, `output`, `text`, or `response` also work instead of `reply`. Account, payment, and specialist requests are handed to the store team.

For a local self-hosted n8n instance, set `N8N_ALLOW_LOCALHOST=true` and use `http://localhost:5678/webhook/hi-lite-sales-brain`.

## Useful checks

```bash
npm run build
npm test
```
