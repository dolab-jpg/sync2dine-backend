import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-org-id",
};

const DEFAULT_RECRUITMENT_JOBS = [
  {
    id: "J001",
    data: {
      title: "Senior Sales Representative",
      department: "sales",
      location: "London, UK",
      status: "open",
      description: "Luxury bathroom sales.",
      salaryRange: "£35k-£45k",
      employmentType: "full-time",
      requiredSkills: ["Sales"],
      qualifications: [],
      createdAt: "2026-03-15",
      positions: 2,
    },
  },
  {
    id: "J002",
    data: {
      title: "Microcement Installation Specialist",
      department: "construction",
      location: "Manchester, UK",
      status: "open",
      description: "Microcement specialist.",
      salaryRange: "£32k-£42k",
      employmentType: "full-time",
      requiredSkills: ["Microcement"],
      qualifications: [],
      createdAt: "2026-03-20",
      positions: 3,
    },
  },
  {
    id: "J003",
    data: {
      title: "Office Administrator",
      department: "office",
      location: "Birmingham, UK",
      status: "open",
      description: "Office admin.",
      salaryRange: "£24k-£28k",
      employmentType: "full-time",
      requiredSkills: ["Admin"],
      qualifications: [],
      createdAt: "2026-04-01",
      positions: 1,
    },
  },
];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const url = new URL(req.url);
  const path = url.pathname
    .replace(/^\/functions\/v1\/platform-orgs/, "")
    .replace(/^\/platform-orgs/, "");

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
      const { data: orgs } = await supabase.from("organizations").select("plan, status");
      const active = orgs?.filter((o) => o.status === "active").length ?? 0;
      const trialing = orgs?.filter((o) => o.status === "trial").length ?? 0;
      const pastDue = orgs?.filter((o) => o.status === "past_due").length ?? 0;
      const suspended = orgs?.filter((o) => o.status === "suspended").length ?? 0;
      const planPrice: Record<string, number> = { starter: 99, pro: 199, enterprise: 499 };
      const mrr = (orgs ?? [])
        .filter((o) => o.status === "active" || o.status === "trial")
        .reduce((sum, o) => sum + (planPrice[o.plan] ?? 0), 0);
      return json({
        total: orgs?.length ?? 0,
        active,
        trialing,
        pastDue,
        suspended,
        mrr,
        tokensThisMonth: 0,
        orgCount: orgs?.length ?? 0,
        activeOrgs: active,
      });
    }

    if (path === "" && req.method === "GET") {
      const { data, error } = await supabase
        .from("organizations")
        .select("*")
        .order("created_at", { ascending: false });
      if (error) throw error;
      return json({ organizations: (data ?? []).map(mapOrg) });
    }

    if (path === "" && req.method === "POST") {
      const body = await req.json();
      const result = await provisionOrganization(supabase, body);
      if ("error" in result) {
        return json({ error: result.error }, result.status);
      }
      return json({
        organization: mapOrg(result.organization),
        mainUserEmail: result.mainUserEmail,
        mainUserCreated: true,
      }, 201);
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
        return json({ organization: mapOrg(data) });
      }
      if (req.method === "PATCH") {
        const body = await req.json();
        const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
        if (body.name) updates.name = body.name;
        if (body.contactName !== undefined) updates.contact_name = body.contactName;
        if (body.contactEmail !== undefined) updates.contact_email = body.contactEmail;
        if (body.contactPhone !== undefined) updates.contact_phone = body.contactPhone;
        if (body.address !== undefined) updates.address = body.address;
        if (body.status) updates.status = body.status;
        if (body.plan) updates.plan = body.plan;
        if (body.monthlyTokenCap !== undefined) updates.monthly_token_cap = body.monthlyTokenCap;
        if (body.notes !== undefined) updates.notes = body.notes;
        const { data, error } = await supabase
          .from("organizations")
          .update(updates)
          .eq("id", orgId)
          .select()
          .single();
        if (error) throw error;
        return json({ organization: mapOrg(data) });
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

async function provisionOrganization(
  supabase: SupabaseClient,
  body: Record<string, unknown>,
): Promise<
  | { organization: Record<string, unknown>; mainUserEmail: string }
  | { error: string; status: number }
> {
  const name = String(body.name ?? "").trim();
  const contactEmail = String(body.contactEmail ?? "").trim().toLowerCase();
  const contactName = String(body.contactName ?? name).trim() || name;
  const adminPassword = String(body.adminPassword ?? "").trim();

  if (!name || !contactEmail) {
    return { error: "Company name and contact email are required", status: 400 };
  }
  if (!adminPassword || adminPassword.length < 8) {
    return { error: "Main user password is required (min 8 characters)", status: 400 };
  }

  const plan = (body.plan as string) || "starter";
  const tokenCaps: Record<string, number> = {
    starter: 500000,
    pro: 2000000,
    enterprise: 10000000,
  };
  const monthlyTokenCap = Number(body.monthlyTokenCap) || tokenCaps[plan] || 500000;

  const { data: org, error: orgError } = await supabase
    .from("organizations")
    .insert({
      name,
      contact_name: contactName,
      contact_email: contactEmail,
      contact_phone: String(body.contactPhone ?? ""),
      address: body.address ? String(body.address) : null,
      plan,
      status: "trial",
      monthly_token_cap: monthlyTokenCap,
      notes: body.notes ? String(body.notes) : null,
      trial_ends_at: new Date(Date.now() + 14 * 86400000).toISOString(),
    })
    .select()
    .single();

  if (orgError || !org) {
    return { error: orgError?.message ?? "Failed to create organization", status: 500 };
  }

  const { data: authData, error: authError } = await supabase.auth.admin.createUser({
    email: contactEmail,
    password: adminPassword,
    email_confirm: true,
    user_metadata: {
      name: contactName,
      role: "super_admin",
      org_id: org.id,
    },
  });

  if (authError || !authData.user) {
    await supabase.from("organizations").delete().eq("id", org.id);
    return {
      error: authError?.message ?? "Failed to create main user",
      status: 400,
    };
  }

  const { error: profileError } = await supabase.from("profiles").upsert({
    id: authData.user.id,
    email: contactEmail,
    name: contactName,
    role: "super_admin",
    org_id: org.id,
    updated_at: new Date().toISOString(),
  });

  if (profileError) {
    await supabase.auth.admin.deleteUser(authData.user.id);
    await supabase.from("organizations").delete().eq("id", org.id);
    return { error: profileError.message, status: 500 };
  }

  await seedOrgDefaults(supabase, org.id as string);

  return { organization: org as Record<string, unknown>, mainUserEmail: contactEmail };
}

async function seedOrgDefaults(supabase: SupabaseClient, orgId: string) {
  await supabase.from("agent_settings").upsert({
    org_id: orgId,
    is_active: true,
    data: { updatedAt: new Date().toISOString() },
  }, { onConflict: "org_id" });

  await supabase.from("recruitment_jobs").upsert(
    DEFAULT_RECRUITMENT_JOBS.map((job) => ({
      id: job.id,
      org_id: orgId,
      data: { ...job.data, createdAt: new Date().toISOString().slice(0, 10) },
    })),
    { onConflict: "org_id,id" },
  );
}

function mapOrg(row: Record<string, unknown>) {
  const plan = String(row.plan ?? "starter");
  const planPrice: Record<string, number> = { starter: 99, pro: 199, enterprise: 499 };
  const planLabel: Record<string, string> = {
    starter: "Starter",
    pro: "Pro",
    enterprise: "Enterprise",
  };
  return {
    id: row.id,
    name: row.name,
    contactName: row.contact_name ?? "",
    contactEmail: row.contact_email ?? "",
    contactPhone: row.contact_phone ?? "",
    address: row.address ?? undefined,
    status: row.status,
    plan: row.plan,
    openaiApiKeyEncrypted: row.openai_api_key_encrypted
      ? String(row.openai_api_key_encrypted).slice(0, 8) + "…"
      : "",
    monthlyTokenCap: Number(row.monthly_token_cap ?? 500000),
    tokensUsedThisMonth: 0,
    monthlyPriceGbp: planPrice[plan] ?? 99,
    planLabel: planLabel[plan] ?? plan,
    stripeCustomerId: row.stripe_customer_id ?? undefined,
    stripeSubscriptionId: row.stripe_subscription_id ?? undefined,
    subscriptionStatus: row.subscription_status ?? undefined,
    currentPeriodEnd: row.current_period_end ?? undefined,
    trialEndsAt: row.trial_ends_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    notes: row.notes ?? undefined,
  };
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
