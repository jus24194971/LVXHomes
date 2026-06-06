/**
 * Renders a JSON-LD <script>. Server-generated, trusted data — the JSON is
 * stringified from our own objects, never user input.
 */
export function JsonLd({ data }: { data: Record<string, unknown> }) {
  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: JSON.stringify(data) }}
    />
  );
}
