import { PLACEHOLDER_STREAM_UID } from "@/lib/stream";

/**
 * Portfolio data (no CMS for v1). The two real films exist already and just
 * need their UIDs/details filled in once uploaded to Stream. The third is a
 * placeholder so the featured grid reads as three. Everything TODO-marked is
 * pending Justin's real assets.
 */

export type Tier = "Signature" | "Showcase" | "Estate";

export type Project = {
  slug: string;
  title: string;
  address: string;
  neighborhood: string;
  /** Display price, e.g. "$1,650,000" or "Private". */
  price: string;
  /** Short label for cards, e.g. "$1M–$2M". */
  priceTier: string;
  beds: number;
  baths: number;
  sqft: number;
  agent: string;
  brokerage: string;
  streamUid: string;
  /** Optional poster override; defaults to the Stream thumbnail. */
  poster?: string;
  tier: Tier;
  /** Short note on the shoot, shown on the detail page. */
  note: string;
  featured?: boolean;
};

export const PROJECTS: Project[] = [
  {
    // Retitled from the "Parents House" test shoot per the brief.
    slug: "private-residence-mesa",
    title: "Private Residence — Mesa, AZ",
    address: "Mesa, Arizona", // kept private
    neighborhood: "Mesa",
    price: "Private",
    priceTier: "Private Residence",
    beds: 4, // TODO: confirm
    baths: 3, // TODO: confirm
    sqft: 2800, // TODO: confirm
    agent: "TODO: agent name",
    brokerage: "TODO: brokerage",
    streamUid: PLACEHOLDER_STREAM_UID, // TODO: real Stream UID
    tier: "Showcase",
    note: "The first flight — the shoot that proved a whole home could be shown from the air, street to back patio, from angles a walkthrough never reaches.",
    featured: true,
  },
  {
    slug: "scottsdale-listing", // TODO: real slug from the address
    title: "TODO: Address — Scottsdale, AZ",
    address: "Scottsdale, Arizona",
    neighborhood: "Scottsdale",
    price: "$1,650,000", // TODO: confirm
    priceTier: "$1M–$2M",
    beds: 5, // TODO
    baths: 4, // TODO
    sqft: 4200, // TODO
    agent: "TODO: agent name",
    brokerage: "TODO: brokerage",
    streamUid: PLACEHOLDER_STREAM_UID, // TODO: real Stream UID
    tier: "Estate",
    note: "TODO: a sentence on the shoot — the light, the line through the house, what made it sing.",
    featured: true,
  },
  {
    slug: "paradise-valley-estate", // TODO placeholder entry
    title: "TODO: Address — Paradise Valley, AZ",
    address: "Paradise Valley, Arizona",
    neighborhood: "Paradise Valley",
    price: "$2,400,000", // TODO
    priceTier: "$2M+",
    beds: 6, // TODO
    baths: 6, // TODO
    sqft: 6100, // TODO
    agent: "TODO: agent name",
    brokerage: "TODO: brokerage",
    streamUid: PLACEHOLDER_STREAM_UID, // TODO: real Stream UID
    tier: "Estate",
    note: "TODO: shoot note.",
    featured: true,
  },
];

export const FEATURED: Project[] = PROJECTS.filter((p) => p.featured).slice(0, 3);

export const getProject = (slug: string): Project | undefined =>
  PROJECTS.find((p) => p.slug === slug);

export const projectIndex = (slug: string): number =>
  PROJECTS.findIndex((p) => p.slug === slug);
