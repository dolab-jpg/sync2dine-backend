import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-org-id",
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
  const path = url.pathname.replace(/^\/platform-orgs/, "");

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return json({ error: "Unauthorized" }, 401);
    }

    const userClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } },
    );
    const { data: { user } } = await userClient.auth.getUser();
    if (!user) return json({ error: "Unauthorized" }, 401);

    const { data: profile } = await supabase
      .from("profiles")
      .select("role")
      .eq("id", user.id)
      .single();

    if (profile?.role !== "platform_owner") {
      return json({ error: "Forbidden" }, 403);
    }

    if (path === "/stats" && req.method === "GET") {
      const { count: orgCount } = await supabase
        .from("organizations")
        .select("*", { count: "exact", head: true });
      const { data: orgs } = await supabase.from("organizations").select("plan, status");
      const active = orgs?.filter((o) => o.status === "active").length ?? 0;
      return json({ orgCount, activeOrgs: active, mrr: active * 199 });
    }

    if (path === "" && req.method === "GET") {
      const { data, error } = await supabase
        .from("organizations")
        .select("*")
        .order("created_at", { ascending: false });
      if (error) throw error;
      return json({ organizations: data });
    }

    if (path === "" && req.method === "POST") {
      const body = await req.json();
      const { data, error } = await supabase
        .from("organizations")
        .insert({
          name: body.name,
          contact_name: body.contactName ?? "",
          contact_email: body.contactEmail ?? "",
          contact_phone: body.contactPhone ?? "",
          plan: body.plan ?? "starter",
          status: "trial",
          monthly_token_cap: body.monthlyTokenCap ?? 500000,
        })
        .select()
        .single();
      if (error) throw error;
      return json({ organization: data }, 201);
    }

    const orgMatch = path.match(/^\/([^/]+)$/);
    if (orgMatch) {
      const orgId = orgMatch[1];
      if (req.method === "GET") {
        const { data, error } = await supabase
          .from("organizations")
          .select("*")
          .eq("id", orgId)
          .single();
        if (error) throw error;
        return json({ organization: data });
      }
      if (req.method === "PATCH") {
        const body = await req.json();
        const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
        if (body.name) updates.name = body.name;
        if (body.status) updates.status = body.status;
        if (body.plan) updates.plan = body.plan;
        const { data, error } = await supabase
          .from("organizations")
          .update(updates)
          .eq("id", orgId)
          .select()
          .single();
        if (error) throw error;
        return json({ organization: data });
      }
      if (req.method === "DELETE") {
        const { error } = await supabase.from("organizations").delete().eq("id", orgId);
        if (error) throw error;
        return json({ success: true });
      }
    }

    const usageMatch = path.match(/^\/([^/]+)\/usage$/);
    if (usageMatch && req.method === "GET") {
      const orgId = usageMatch[1];
      const { data, error } = await supabase
        .from("usage_events")
        .select("total_tokens, created_at")
        .eq("org_id", orgId)
        .gte("created_at", new Date(Date.now() - 30 * 86400000).toISOString());
      if (error) throw error;
      const totalTokens = data?.reduce((s, e) => s + (e.total_tokens ?? 0), 0) ?? 0;
      return json({ totalTokens, events: data?.length ?? 0 });
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
