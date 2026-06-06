/**
 * Testimonials. Credibility is the names — never anonymous. These are TODO
 * placeholders; replace with real quotes (agent + brokerage + listing price)
 * collected from the founding shoots before launch.
 */

export type Testimonial = {
  quote: string;
  agent: string;
  brokerage: string;
  price: string; // listing price for credibility
};

export const TESTIMONIALS: Testimonial[] = [
  {
    quote:
      "TODO: a real quote from a founding-client agent. Two sentences, specific — what the film did for the listing.",
    agent: "TODO: Agent Name",
    brokerage: "TODO: Brokerage",
    price: "$1,650,000",
  },
  {
    quote:
      "TODO: a second real quote — ideally one that mentions winning the listing or the buyer response.",
    agent: "TODO: Agent Name",
    brokerage: "TODO: Brokerage",
    price: "$2,400,000",
  },
];
