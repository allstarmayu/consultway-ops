/**
 * OrganizationSection — workspace-level details, admin / staff only.
 *
 * Pure local form state this round. When `organizations` (or whatever we
 * call the internal-org table) lands, swap the mock save for the
 * matching Server Action and pass the initial values down from the
 * page-level Server Component.
 *
 * @module app/dashboard/settings/_components/organization-section
 */
"use client";

import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Globe2 } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { FormField } from "@/components/forms/form-field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SectionCard } from "./section-card";
import { StickySaveBar } from "./sticky-save-bar";

interface OrgForm {
  name: string;
  industry: string;
  website: string;
  timezone: string;
  contactEmail: string;
  addressLine1: string;
  city: string;
  state: string;
}

const INDUSTRY_OPTIONS = [
  "Construction & Infrastructure",
  "Solar & Renewables",
  "Consulting Services",
  "Public Sector",
  "Other",
];

const TIMEZONE_OPTIONS = [
  "Asia/Kolkata",
  "Asia/Singapore",
  "Asia/Dubai",
  "Europe/London",
  "America/New_York",
];

export function OrganizationSection() {
  const initial = useMemo<OrgForm>(
    () => ({
      name: "Consultway Infotech",
      industry: "Consulting Services",
      website: "https://consultway.in",
      timezone: "Asia/Kolkata",
      contactEmail: "hello@consultway.in",
      addressLine1: "",
      city: "Mumbai",
      state: "Maharashtra",
    }),
    [],
  );

  const [form, setForm] = useState<OrgForm>(initial);
  const [isSaving, setIsSaving] = useState(false);

  const isDirty = (Object.keys(initial) as Array<keyof OrgForm>).some(
    (k) => form[k] !== initial[k],
  );

  function update<K extends keyof OrgForm>(key: K, value: OrgForm[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  async function handleSave() {
    setIsSaving(true);
    await new Promise((r) => setTimeout(r, 700));
    setIsSaving(false);
    Object.assign(initial, form);
    toast.success("Organization details saved");
  }

  return (
    <>
      <div className="space-y-6">
        <SectionCard
          id="section-heading-organization"
          title="Organization"
          description="The workspace these settings apply to."
          headerAside={
            <a
              href={form.website || "#"}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-xs text-accent hover:underline"
            >
              <Globe2 className="h-3 w-3" aria-hidden />
              {prettyDomain(form.website) || "No website set"}
            </a>
          }
        >
          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
            <FormField name="org-name" label="Organization name" required>
              <Input
                value={form.name}
                onChange={(e) => update("name", e.target.value)}
              />
            </FormField>

            <FormField name="org-industry" label="Industry">
              <Select
                value={form.industry}
                onValueChange={(v) => update("industry", v)}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {INDUSTRY_OPTIONS.map((opt) => (
                    <SelectItem key={opt} value={opt}>
                      {opt}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>

            <FormField name="org-website" label="Website">
              <Input
                type="url"
                value={form.website}
                onChange={(e) => update("website", e.target.value)}
                placeholder="https://"
              />
            </FormField>

            <FormField name="org-contact" label="Public contact email">
              <Input
                type="email"
                value={form.contactEmail}
                onChange={(e) => update("contactEmail", e.target.value)}
              />
            </FormField>

            <FormField name="org-timezone" label="Default timezone">
              <Select
                value={form.timezone}
                onValueChange={(v) => update("timezone", v)}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TIMEZONE_OPTIONS.map((tz) => (
                    <SelectItem key={tz} value={tz}>
                      {tz}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>
          </div>
        </SectionCard>

        <SectionCard
          title="Office address"
          description="Used on PDF reports and registration forms."
        >
          <div className="grid grid-cols-1 gap-5">
            <FormField name="org-address" label="Street address">
              <Textarea
                value={form.addressLine1}
                rows={2}
                onChange={(e) => update("addressLine1", e.target.value)}
                placeholder="Unit, building, street, area"
              />
            </FormField>
            <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
              <FormField name="org-city" label="City">
                <Input
                  value={form.city}
                  onChange={(e) => update("city", e.target.value)}
                />
              </FormField>
              <FormField name="org-state" label="State / region">
                <Input
                  value={form.state}
                  onChange={(e) => update("state", e.target.value)}
                />
              </FormField>
            </div>
          </div>
        </SectionCard>
      </div>

      <StickySaveBar
        isDirty={isDirty}
        isSaving={isSaving}
        onSave={handleSave}
        onCancel={() => setForm(initial)}
      />
    </>
  );
}

/** "https://consultway.in/foo" → "consultway.in". Empty string → "". */
function prettyDomain(url: string): string {
  if (!url) return "";
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}
