"use client";

import { useState, type ChangeEvent, type FormEvent } from "react";
import { Button } from "@/components/ui/button";

const PRICE_RANGES = ["Under $750k", "$750k – $1M", "$1M – $2M", "$2M+"];
const PACKAGE_OPTIONS = ["Signature", "Showcase", "Estate", "Not sure yet"];

type Status = "idle" | "submitting" | "success" | "error";

const FIELD =
  "w-full border border-sand bg-paper px-4 py-3 font-sans text-sm font-light text-ink placeholder:text-taupe/60 transition-colors focus:border-champagne focus:outline-none";
const LABEL =
  "mb-2 block font-sans text-[0.6875rem] uppercase tracking-[0.18em] text-taupe";

const EMPTY = {
  name: "",
  email: "",
  phone: "",
  brokerage: "",
  listingAddress: "",
  priceRange: "",
  packageInterest: "",
  message: "",
  company: "", // honeypot
};

export function ContactForm() {
  const [form, setForm] = useState(EMPTY);
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState("");

  const update =
    (k: keyof typeof EMPTY) =>
    (
      e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>,
    ) =>
      setForm((prev) => ({ ...prev, [k]: e.target.value }));

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setStatus("submitting");
    setError("");
    try {
      const res = await fetch("/api/contact", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error || "Something went wrong. Please try again.");
      }
      setStatus("success");
    } catch (err) {
      setStatus("error");
      setError(
        err instanceof Error ? err.message : "Something went wrong. Please try again.",
      );
    }
  }

  if (status === "success") {
    return (
      <div className="border border-champagne/50 bg-card p-10 text-center">
        <p className="font-serif text-2xl italic text-ink">Thank you.</p>
        <p className="mt-3 font-sans text-sm font-light leading-relaxed text-espresso/80">
          Your inquiry is in. I&apos;ll reply within one business day.
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} noValidate className="relative flex flex-col gap-6">
      {/* Honeypot — off-screen, bots fill it, humans never see it */}
      <div aria-hidden className="absolute -left-[9999px] top-0 h-0 w-0 overflow-hidden">
        <label>
          Company
          <input
            type="text"
            tabIndex={-1}
            autoComplete="off"
            value={form.company}
            onChange={update("company")}
          />
        </label>
      </div>

      <div className="grid gap-6 sm:grid-cols-2">
        <div>
          <label htmlFor="name" className={LABEL}>
            Name <span className="text-champagne-dk">*</span>
          </label>
          <input
            id="name"
            type="text"
            required
            value={form.name}
            onChange={update("name")}
            className={FIELD}
          />
        </div>
        <div>
          <label htmlFor="email" className={LABEL}>
            Email <span className="text-champagne-dk">*</span>
          </label>
          <input
            id="email"
            type="email"
            required
            value={form.email}
            onChange={update("email")}
            className={FIELD}
          />
        </div>
      </div>

      <div className="grid gap-6 sm:grid-cols-2">
        <div>
          <label htmlFor="phone" className={LABEL}>
            Phone
          </label>
          <input
            id="phone"
            type="tel"
            value={form.phone}
            onChange={update("phone")}
            className={FIELD}
          />
        </div>
        <div>
          <label htmlFor="brokerage" className={LABEL}>
            Brokerage
          </label>
          <input
            id="brokerage"
            type="text"
            value={form.brokerage}
            onChange={update("brokerage")}
            className={FIELD}
          />
        </div>
      </div>

      <div>
        <label htmlFor="listingAddress" className={LABEL}>
          Listing address
        </label>
        <input
          id="listingAddress"
          type="text"
          value={form.listingAddress}
          onChange={update("listingAddress")}
          className={FIELD}
        />
      </div>

      <div className="grid gap-6 sm:grid-cols-2">
        <div>
          <label htmlFor="priceRange" className={LABEL}>
            Price range
          </label>
          <select
            id="priceRange"
            value={form.priceRange}
            onChange={update("priceRange")}
            className={FIELD}
          >
            <option value="">Select…</option>
            {PRICE_RANGES.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="packageInterest" className={LABEL}>
            Package
          </label>
          <select
            id="packageInterest"
            value={form.packageInterest}
            onChange={update("packageInterest")}
            className={FIELD}
          >
            <option value="">Select…</option>
            {PACKAGE_OPTIONS.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div>
        <label htmlFor="message" className={LABEL}>
          Message <span className="text-champagne-dk">*</span>
        </label>
        <textarea
          id="message"
          required
          rows={5}
          value={form.message}
          onChange={update("message")}
          className={`${FIELD} resize-y`}
        />
      </div>

      {status === "error" && (
        <p role="alert" className="font-sans text-sm text-[#9a3412]">
          {error}
        </p>
      )}

      <div className="pt-2">
        <Button
          type="submit"
          variant="solid"
          disabled={status === "submitting"}
          className="w-full disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto"
        >
          {status === "submitting" ? "Sending…" : "Send inquiry"}
        </Button>
      </div>
    </form>
  );
}
