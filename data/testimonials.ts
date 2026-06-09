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

// Empty until real quotes land — the homepage section auto-hides when this is
// empty, so it never shows placeholder/fake social proof. Re-add entries
// (quote + agent + brokerage + price) from the founding shoots to bring it back.
export const TESTIMONIALS: Testimonial[] = [];
