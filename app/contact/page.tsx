import type { Metadata } from "next";
import { ContactForm } from "@/components/contact/contact-form";
import { Container } from "@/components/ui/container";
import { Eyebrow } from "@/components/ui/eyebrow";
import { Section } from "@/components/ui/section";
import { SITE } from "@/data/site";

export const metadata: Metadata = {
  title: "Contact",
  alternates: { canonical: "/contact" },
  description:
    "Inquire about filming your listing. LVX Homes — Phoenix, Mesa, Scottsdale, and Paradise Valley.",
};

export default function ContactPage() {
  return (
    <Section spacing="normal" className="pt-20 sm:pt-28">
      <Container narrow>
        <Eyebrow>Inquire</Eyebrow>
        <h1 className="mt-6 font-display text-4xl font-normal leading-[1.1] tracking-[0.04em] text-ink sm:text-5xl">
          LET&apos;S FILM IT
        </h1>
        <p className="mt-6 font-serif text-xl font-light italic leading-relaxed text-espresso sm:text-2xl">
          Tell me about the listing — the address, the price, what makes it
          special. I&apos;ll get back to you within a day.
        </p>

        <div className="mt-12">
          <ContactForm />
        </div>

        <p className="mt-10 font-sans text-sm font-light text-taupe">
          Prefer email?{" "}
          <a
            href={`mailto:${SITE.email}`}
            className="text-champagne-dk underline-offset-4 hover:underline"
          >
            {SITE.email}
          </a>
        </p>
      </Container>
    </Section>
  );
}
