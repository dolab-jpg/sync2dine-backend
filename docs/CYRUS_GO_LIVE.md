# Cyrus + OpenAI go-live checklist

1. **Integrations → OpenAI** — paste a live `sk-…` key, click **Save**, then **Test Connection** (must show connected). Master mock mode turns off automatically when you save a valid key.
2. **Integrations → Company Profile** — set **Website** to your live company site URL (used for embed origin checks). Copy the **Cyrus website chat** script snippet into that site’s footer/theme.
3. **Integrations → WhatsApp** — configure Meta credentials for production; turn off mock mode.
4. Set `INTEGRATIONS_MOCK_MODE=false` in production env (`.env` / host secrets).
5. Confirm `OPENAI_API_KEY` org key is stored (Super Admin Save) or env fallback for single-tenant.
6. Smoke test: Integrations → WhatsApp → Simulate inbound, or open `/cyrus` and use **Ask Cyrus**. Website visitors use the embed; portal clients use **Ask Cyrus** on `/portal/:token`.
