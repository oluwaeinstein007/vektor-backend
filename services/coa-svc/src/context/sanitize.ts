// Pitfall 4 mitigation — "coa-svc's context builder sanitizes all string
// fields via sanitizeForPrompt() before assembling the prompt." Sensor
// metadata (names, tags, analyst notes) flows into the COA prompt context;
// a crafted string in one of those fields could otherwise inject
// instructions into the LLM. This strips the two things that let free text
// masquerade as delimiters/instructions once it's serialized into the
// situation JSON: literal newlines (which could fake a new "field" or
// break out of a JSON string in a hand-rolled prompt template) and markdown
// code fences / instruction-shaped prefixes a model might weight heavily.
const INJECTION_PATTERNS = [
  /ignore (all |any )?(previous|prior|above) instructions?/gi,
  /system\s*:/gi,
  /assistant\s*:/gi,
  /```/g,
];

export function sanitizeForPrompt(input: string): string {
  let text = input.replace(/[\r\n\t]+/g, " ").trim();
  for (const pattern of INJECTION_PATTERNS) {
    text = text.replace(pattern, "[redacted]");
  }
  // A single sensor note field shouldn't be able to blow up the prompt
  // budget either — cap it generously above any legitimate analyst note.
  return text.slice(0, 2000);
}
