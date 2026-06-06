/**
 * Service tiers, add-ons, and process. Shared by the Home teaser and the
 * Services page. PRICING + FEATURES ARE TODO — confirm against the flyer before
 * launch. Presented as founding-client / introductory, never "cheap".
 */

export type Tier = "Signature" | "Showcase" | "Estate";

export type Package = {
  name: Tier;
  tagline: string; // one-line positioning
  price: number; // TODO: confirm
  unit: string;
  features: string[];
  featured?: boolean;
};

export const PACKAGES: Package[] = [
  {
    name: "Signature",
    tagline: "The aerial film that shows what photos can't.",
    price: 450,
    unit: "per listing",
    features: [
      "Cinematic FPV flythrough",
      "Homes up to ~2,500 sq ft",
      "48-hour delivery",
      "One vertical social cut",
      "Licensed music",
    ],
  },
  {
    name: "Showcase",
    tagline: "The full film — interior, grounds, and the approach.",
    price: 850,
    unit: "per listing",
    featured: true,
    features: [
      "Everything in Signature",
      "Homes up to ~5,000 sq ft",
      "Twilight exterior pass",
      "Two social cuts (vertical + horizontal)",
      "Cinematic color grade",
    ],
  },
  {
    name: "Estate",
    tagline: "For the listing that has to feel like an event.",
    price: 1500,
    unit: "per listing",
    features: [
      "Everything in Showcase",
      "Unlimited square footage + grounds",
      "Three social cuts + a teaser",
      "Priority scheduling",
      "On-set direction with the agent",
    ],
  },
];

export type AddOn = { name: string; price: number };

export const ADDONS: AddOn[] = [
  { name: "Twilight shoot", price: 200 },
  { name: "Rush 24-hour delivery", price: 150 },
  { name: "Extra social cut", price: 60 },
  { name: "Matterport / floor plan", price: 175 },
];

export type ProcessStep = { step: string; detail: string };

export const PROCESS: ProcessStep[] = [
  { step: "Book", detail: "A short call, a date, an address." },
  { step: "Shoot", detail: "One visit. We fly the home in a single take." },
  { step: "48-hour delivery", detail: "Graded film and social cuts, ready to post." },
  { step: "You win the listing", detail: "Marketing that makes the agent look premium." },
];

export const PACKAGES_BY_NAME: Record<Tier, Package> = PACKAGES.reduce(
  (acc, p) => ({ ...acc, [p.name]: p }),
  {} as Record<Tier, Package>,
);
