// Paragraph-aware chunking for doctrine/SOP markdown source docs (ML-008's
// ingestion side). Doctrine documents in this project are short (a few KB),
// so this deliberately doesn't do token-aware splitting or a sliding window —
// it groups consecutive paragraphs up to maxChars, only ever breaking on a
// blank line, so a chunk never cuts a sentence in half.
export interface DoctrineChunk {
  text: string;
  chunk_index: number;
}

export function chunkDoctrine(source: string, maxChars = 800): DoctrineChunk[] {
  const paragraphs = source
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  const chunks: DoctrineChunk[] = [];
  let current = "";

  for (const paragraph of paragraphs) {
    const candidate = current ? `${current}\n\n${paragraph}` : paragraph;
    if (candidate.length > maxChars && current) {
      chunks.push({ text: current, chunk_index: chunks.length });
      current = paragraph;
    } else {
      current = candidate;
    }
  }
  if (current) {
    chunks.push({ text: current, chunk_index: chunks.length });
  }

  return chunks;
}
