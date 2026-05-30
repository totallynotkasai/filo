export function normalizeExtension(raw: string | undefined | null): string {
  return (raw ?? '').toLowerCase().replace(/^\./, '');
}

export function isMarkdownExtension(raw: string | undefined | null): boolean {
  const ext = normalizeExtension(raw);
  return ext === 'md' || ext === 'markdown';
}
