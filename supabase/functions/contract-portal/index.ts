import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/contract-portal/, "");
  const token = url.searchParams.get("token") ?? path.split("/").filter(Boolean)[0];

  if (!token) {
    return json({ error: "Token required" }, 400);
  }

  try {
    // Portal access (project by portal token)
    if (path.startsWith("/portal") || url.searchParams.get("type") === "portal") {
      const { data, error } = await supabase.rpc("get_project_by_portal_token", { token });
      if (error) throw error;
      if (!data) return json({ error: "Invalid or expired portal link" }, 404);
      return json(data);
    }

    // Contract view
    if (req.method === "GET") {
      const { data, error } = await supabase.rpc("get_contract_by_token", { token });
      if (error) throw error;
      if (!data) return json({ error: "Contract not found" }, 404);
      return json(data);
    }

    // Contract sign
    if (req.method === "POST") {
      const body = await req.json();
      const { data: existing, error: fetchErr } = await supabase
        .from("contracts")
        .select("*")
        .eq("signing_token", token)
        .single();
      if (fetchErr || !existing) return json({ error: "Contract not found" }, 404);

      const signature = {
        signedAt: new Date().toISOString(),
        signedBy: body.signedBy ?? "Customer",
        ipHash: body.ipHash ?? null,
      };

      const { data, error } = await supabase
        .from("contracts")
        .update({
          status: "signed",
          signed_at: signature.signedAt,
          data: { ...existing.data, signature },
          updated_at: new Date().toISOString(),
        })
        .eq("signing_token", token)
        .select()
        .single();
      if (error) throw error;
      return json({ success: true, contract: data });
    }

    return json({ error: "Not found" }, 404);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal error";
    return json({ error: message }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
