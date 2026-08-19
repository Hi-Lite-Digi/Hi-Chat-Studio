# Hi-Lite multi-store sales brain

Import `hi-lite-multi-store-sales-brain.json` into the same n8n workspace used for the Sia Huat assistant.

1. Open the **OpenAI Chat Model** node and select the existing OpenAI credential.
2. Save and activate the workflow.
3. Copy its production webhook URL into this app's `.env.local` as `N8N_WEBHOOK_URL`.
4. Set `N8N_REQUIRED=true`, then restart the local app.

The workflow receives a store profile, a full-catalogue overview, up to 18 relevant product records, recent chat history, and the current customer message. The model writes only the customer-facing sales reply. Product facts and prices remain grounded in the scanned catalogue.

For a self-hosted local n8n instance, set `N8N_ALLOW_LOCALHOST=true` and use `http://localhost:5678/webhook/hi-lite-sales-brain`.
