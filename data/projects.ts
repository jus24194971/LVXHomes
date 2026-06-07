/**
 * Portfolio films (no CMS for v1). These are PORTFOLIO pieces — real Arizona
 * homes filmed to demonstrate the work — NOT client listings. So: no price, no
 * listing agent, no brokerage, no "for sale" framing. Just the film, the place,
 * and a short note on the shoot.
 */

export type Project = {
  slug: string;
  title: string; // location-titled, e.g. "San Tan Valley, AZ"
  location: string; // "San Tan Valley, Arizona"
  /** Optional one-line descriptor shown on cards/detail (e.g. property type). */
  summary?: string;
  streamUid: string;
  /** Optional poster override; defaults to the Stream thumbnail. */
  poster?: string;
  /** Short note on the shoot, shown on the detail page. */
  note: string;
  featured?: boolean;
};

export const PROJECTS: Project[] = [
  {
    slug: "san-tan-valley",
    title: "San Tan Valley, AZ",
    location: "San Tan Valley, Arizona",
    // summary: "TODO: optional one-line descriptor",
    streamUid: "d0cde33269c8528f1a71ad128aa54310",
    note: "A portfolio flight through a San Tan Valley home — desert light, clean lines, and the kind of continuous motion that a walkthrough can't give you.",
    featured: true,
  },
  {
    slug: "tucson",
    title: "Tucson, AZ",
    location: "Tucson, Arizona",
    // summary: "TODO: optional one-line descriptor",
    streamUid: "95edfc133cea3de428456555e999247e",
    note: "Filmed in Tucson — a portfolio piece that shows how the camera moves through and around a home, finding the angles you never get on foot.",
    featured: true,
  },
];

export const FEATURED: Project[] = PROJECTS.filter((p) => p.featured);

export const getProject = (slug: string): Project | undefined =>
  PROJECTS.find((p) => p.slug === slug);
