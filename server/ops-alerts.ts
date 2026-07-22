/**
 * Urgent platform alerts — e.g. orders falling back to disk when Supabase is down.
 * Phone can keep taking orders; staff see a banner on the main restaurant shell.
 */

export type OpsAlertSeverity = 'critical' | 'high' | 'info';

export interface OpsAlert {
  id: string;
  orgId: string;
  severity: OpsAlertSeverity;
  code: string;
  title: string;
  message: string;
  createdAt: string;
  acknowledgedAt?: string;
}

const alerts: OpsAlert[] = [];
const MAX = 100;
const DEDUPE_MS = 5 * 60 * 1000;
const lastRaised = new Map<string, number>();

export function raiseOpsAlert(input: {
  orgId: string;
  severity: OpsAlertSeverity;
  code: string;
  title: string;
  message: string;
}): OpsAlert | null {
  const key = `${input.orgId}:${input.code}`;
  const now = Date.now();
  const prev = lastRaised.get(key) ?? 0;
  if (now - prev < DEDUPE_MS) return null;
  lastRaised.set(key, now);

  const alert: OpsAlert = {
    id: `alert-${now}-${Math.random().toString(36).slice(2, 8)}`,
    orgId: input.orgId,
    severity: input.severity,
    code: input.code,
    title: input.title,
    message: input.message,
    createdAt: new Date().toISOString(),
  };
  alerts.unshift(alert);
  if (alerts.length > MAX) alerts.length = MAX;
  console.error(`[ops-alert:${input.severity}] ${input.code} org=${input.orgId} ${input.title} — ${input.message}`);
  return alert;
}

export function listOpsAlerts(orgId: string, opts?: { includeAcked?: boolean }): OpsAlert[] {
  return alerts.filter((a) => {
    if (a.orgId !== orgId) return false;
    if (!opts?.includeAcked && a.acknowledgedAt) return false;
    return true;
  });
}

export function acknowledgeOpsAlert(orgId: string, id: string): OpsAlert | null {
  const row = alerts.find((a) => a.id === id && a.orgId === orgId);
  if (!row) return null;
  row.acknowledgedAt = new Date().toISOString();
  return row;
}
